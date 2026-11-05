import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Transpile isolated TS modules for Node tests; no production environment or API is used.
function load(name, globals = {}) {
  const file = new URL(`../lib/ai/${name}.ts`, import.meta.url);
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports, require: (id) => { if (id === "server-only") return {}; if (id === "./contracts") return load("contracts"); throw new Error(`Unexpected import: ${id}`); },
    AbortSignal, TextDecoder, setTimeout, clearTimeout, process: { env: {} }, ...globals,
  }, { filename: file.pathname });
  return exports;
}
const { executeSteps } = load("execute");
const steps = [1, 2, 3].map((number) => ({ id: String(number), step_number: number, prompt_text: `Prompt ${number}` }));
const options = (overrides = {}) => ({ steps, initialInput: "Initial input", signal: new AbortController().signal, onStep() {}, onOutput() {}, ...overrides });

test("runs sequentially and passes exactly the previous output to the next step", async () => {
  const calls = [];
  const progress = [];
  const results = [];
  let active = 0;
  await executeSteps(options({
    onStep: (step) => progress.push(step.step_number), onOutput: (output) => results.push(output),
    generate: async (prompt, input) => {
      assert.equal(active++, 0);
      await Promise.resolve();
      calls.push([prompt, input]); active--;
      return `Output ${calls.length}`;
    },
  }));
  assert.deepEqual(calls, [["Prompt 1", "Initial input"], ["Prompt 2", "Output 1"], ["Prompt 3", "Output 2"]]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(results[2].output, "Output 3");
});

test("validates all limits before making paid calls", async () => {
  let calls = 0;
  const generate = async () => { calls++; return "output"; };
  for (const overrides of [
    { initialInput: " " }, { initialInput: "x".repeat(10001) }, { steps: [] },
    { steps: Array.from({ length: 9 }, () => steps[0]) },
    { steps: [steps[0], { ...steps[1], prompt_text: "x".repeat(8001) }] },
    { steps: [{ ...steps[0], step_number: 4 }] },
  ]) await assert.rejects(executeSteps(options({ generate, ...overrides })));
  assert.equal(calls, 0);
});

test("stops after a failed step and preserves earlier progress", async () => {
  const results = [];
  let calls = 0;
  await assert.rejects(executeSteps(options({ onOutput: (result) => results.push(result), generate: async () => {
    if (++calls === 2) throw new Error("Provider failed"); return "First output";
  } })), /Provider failed/);
  assert.equal(calls, 2); assert.equal(results.length, 1);
});

test("rejects empty and oversized outputs and honors cancellation between steps", async () => {
  for (const output of ["", " ", "x".repeat(12001)]) {
    await assert.rejects(executeSteps(options({ generate: async () => output })), /empty or oversized/);
  }
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(executeSteps(options({ signal: abort.signal, generate: async () => {
    calls++; abort.abort(); return "First output";
  } })));
  assert.equal(calls, 1);
});

function provider(fetch) {
  return load("gemini", { fetch, process: { env: { GEMINI_API_KEY: "fake-test-key" } } });
}
const goodResponse = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hidden", thought: true }, { text: "Result" }] } }] });

test("Gemini key stays in a header, responses are bounded, and thoughts are excluded", async () => {
  let request;
  const gemini = provider(async (url, options) => { request = { url, options }; return goodResponse(); });
  assert.equal(await gemini.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Previous output", new AbortController().signal), "Result");
  assert.ok(!request.url.includes("fake-test-key"));
  assert.equal(request.options.headers["x-goog-api-key"], "fake-test-key");
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents[0].parts[0].text, "Previous output");
  assert.equal(body.systemInstruction.parts[0].text, "Prompt");
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
  assert.equal(request.options.redirect, "error");
});

test("provider errors are sanitized and never retried", async () => {
  let calls = 0;
  const gemini = provider(async () => { calls++; throw new Error("fake-test-key secret provider error"); });
  await assert.rejects(gemini.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), (error) => !error.message.includes("fake-test-key") && error.message.includes("Unable to reach"));
  assert.equal(calls, 1);
  for (const status of [401, 403, 404, 429, 500]) {
    const api = provider(async () => new Response("fake-test-key", { status }));
    await assert.rejects(api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), (error) => !error.message.includes("fake-test-key"));
  }
});

test("truncated, blocked, malformed and oversized model results are rejected", async () => {
  for (const response of [
    Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "x".repeat(12001) }] } }] }),
    new Response("not JSON"), new Response("x".repeat(262145)),
  ]) {
    const api = provider(async () => response);
    await assert.rejects(api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal));
  }
});

test("missing keys and invalid model configuration fail safely", () => {
  assert.throws(() => load("gemini").geminiConfiguration(), /GEMINI_API_KEY/);
  assert.throws(() => load("gemini", { process: { env: { GEMINI_API_KEY: "fake", GEMINI_MODEL: "https://example.com" } } }).geminiConfiguration(), /model ID/);
});

function routeHarness({ startError, saveError, generationError, configurationError, authorizationError } = {}) {
  const calls = { database: [], ai: [] };
  const supabase = { rpc: async (name, args) => {
    calls.database.push({ name, args });
    if (name === "begin_prompt_chain_run") return { data: { id: "test-run", steps }, error: startError };
    return { error: saveError };
  } };
  const imports = {
    "@/lib/admin": { requireAdmin: async () => { if (authorizationError) throw authorizationError; return { supabase }; } },
    "@/lib/chain-steps": { isDatabaseId: (id) => /^\d+$/.test(id) },
    "@/lib/ai/contracts": load("contracts"),
    "@/lib/ai/database-errors": load("database-errors"),
    "@/lib/ai/execute": { executeSteps },
    "@/lib/ai/gemini": {
      geminiConfiguration: () => { if (configurationError) throw configurationError; return { model: "gemini-test", apiKey: "fake-test-key" }; },
      generateGeminiText: async (_key, _model, prompt, input) => {
        calls.ai.push({ prompt, input });
        if (generationError && calls.ai.length === 2) throw new Error("Safe provider error");
        return `Output ${calls.ai.length}`;
      },
    },
  };
  const source = ts.transpileModule(readFileSync(new URL("../app/chains/[id]/run/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => imports[id], AbortController, AbortSignal, TextEncoder, TextDecoder, ReadableStream, Response, URL });
  const request = (origin = "https://studio.example", input = "Initial input") => new Request("https://studio.example/chains/1/run", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ initialInput: input }),
  });
  return { calls, post: (req = request()) => exports.POST(req, { params: Promise.resolve({ id: "1" }) }), request };
}

test("route enforces origin and authorization before database writes or AI calls", async () => {
  const origin = routeHarness();
  assert.equal((await origin.post(origin.request("https://attacker.example"))).status, 403);
  assert.equal(origin.calls.database.length, 0); assert.equal(origin.calls.ai.length, 0);
  const auth = routeHarness({ authorizationError: new Error("redirect to login") });
  await assert.rejects(auth.post(), /redirect to login/);
  assert.equal(auth.calls.database.length, 0); assert.equal(auth.calls.ai.length, 0);
});

test("missing keys, missing SQL, quota limits and invalid input never call Gemini", async () => {
  for (const config of [
    { configurationError: new Error("Gemini is not configured") },
    { startError: { code: "PGRST202" } },
    { startError: { code: "PT429", message: "Run limit reached" } },
  ]) {
    const route = routeHarness(config);
    const response = await route.post();
    assert.ok(!response.ok); assert.equal(route.calls.ai.length, 0);
    if (config.configurationError) assert.equal(route.calls.database.length, 0);
  }
  const route = routeHarness();
  assert.equal((await route.post(route.request("https://studio.example", "x".repeat(10001)))).status, 400);
  assert.equal(route.calls.database.length, 0);
});

test("streamed route reports progress and persists complete sequential output", async () => {
  const route = routeHarness();
  const response = await route.post();
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events[0].type, "started");
  assert.equal(events.filter((event) => event.type === "step").length, 3);
  assert.equal(events.at(-1).type, "completed");
  assert.equal(route.calls.ai[1].input, "Output 1");
  const save = route.calls.database.at(-1);
  assert.equal(save.name, "finish_prompt_chain_run"); assert.equal(save.args.p_status, "completed");
  assert.equal(save.args.p_outputs.length, 3);
  assert.ok(!JSON.stringify(events).includes("fake-test-key"));
});

test("failed steps save only completed intermediate outputs and identify the failing step", async () => {
  const route = routeHarness({ generationError: true });
  const events = (await (await route.post()).text()).trim().split("\n").map(JSON.parse);
  assert.equal(route.calls.ai.length, 2);
  assert.equal(events.at(-1).type, "error"); assert.equal(events.at(-1).step, 2);
  assert.equal(events.at(-1).saved, true);
  const save = route.calls.database.at(-1).args;
  assert.equal(save.p_status, "failed"); assert.equal(save.p_outputs.length, 1);
});

test("save failures preserve visible outputs and never claim history was saved", async () => {
  const route = routeHarness({ saveError: { code: "XX000" } });
  const events = (await (await route.post()).text()).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "output").length, 3);
  assert.equal(events.at(-1).type, "error"); assert.equal(events.at(-1).saved, false);
  assert.equal(events.filter((event) => event.type === "completed").length, 0);
});

test("Gemini HTTP failures retain safe status diagnostics and distinguish causes", async () => {
  for (const [status, providerStatus, reason, expected] of [
    [400, "INVALID_ARGUMENT", "API_KEY_INVALID", /rejected the server's API key/],
    [400, "INVALID_ARGUMENT", undefined, /request parameters/],
    [402, "FAILED_PRECONDITION", undefined, /billing or available credits/],
    [403, "PERMISSION_DENIED", "API_KEY_HTTP_REFERRER_BLOCKED", /denied API or model access/],
    [404, "NOT_FOUND", undefined, /model is unavailable/],
    [429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", /quota or rate limit/],
    [500, "INTERNAL", undefined, /server error/],
    [503, "UNAVAILABLE", undefined, /temporarily unavailable or overloaded/],
    [504, "DEADLINE_EXCEEDED", undefined, /timed out/],
  ]) {
    const logs = [];
    const api = load("gemini", {
      fetch: async () => Response.json({ error: { status: providerStatus, message: "fake-test-key private prompt", details: [{ reason, metadata: { key: "fake-test-key", private: "user@example.com" } }] } }, { status }),
      console: { error: (...args) => logs.push(args) },
    });
    await assert.rejects(api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), (error) => {
      assert.match(error.message, expected);
      assert.ok(error.message.includes(`HTTP ${status}`));
      assert.ok(error.message.includes(providerStatus));
      assert.ok(!error.message.includes("fake-test-key"));
      return true;
    });
    assert.equal(logs.length, status === 503 ? 3 : 1);
    const serialized = JSON.stringify(logs);
    assert.ok(serialized.includes(String(status)));
    for (const secret of ["fake-test-key", "private prompt", "user@example.com"]) assert.ok(!serialized.includes(secret));
  }
});

test("HTTP diagnostics reject arbitrary metadata and survive invalid or oversized bodies", async () => {
  for (const body of [
    JSON.stringify({ error: { status: "fake-test-key", message: "fake-test-key", details: [{ reason: "fake-test-key" }] } }),
    "fake-test-key", "x".repeat(16385),
  ]) {
    const logs = [];
    const api = load("gemini", { fetch: async () => new Response(body, { status: 503 }), console: { error: (...args) => logs.push(args) } });
    await assert.rejects(api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), (error) => error.message.includes("HTTP 503") && !error.message.includes("fake-test-key"));
    assert.ok(!JSON.stringify(logs).includes("fake-test-key"));
    assert.equal(logs[0][1].providerStatus, "UNKNOWN");
    assert.equal(logs[0][1].reason, "UNKNOWN");
  }
});

function retryProvider(responses, { abort, onWait } = {}) {
  const calls = [];
  const waits = [];
  const logs = [];
  const random = Object.create(Math);
  random.random = () => 0.25;
  const api = load("gemini", {
    Math: random,
    console: { error: (...args) => logs.push(args) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      return response();
    },
    setTimeout: (callback, delay) => {
      waits.push(delay);
      queueMicrotask(() => { onWait?.(); if (!abort?.signal.aborted) callback(); });
      return waits.length;
    },
    clearTimeout: () => {},
  });
  return { api, calls, waits, logs };
}
const unavailable = () => Response.json({ error: { status: "UNAVAILABLE", message: "fake-test-key private prompt" } }, { status: 503 });

test("503 retries twice with exponential jitter and one shared deadline, then succeeds", async () => {
  const retry = retryProvider([unavailable, unavailable, goodResponse]);
  assert.equal(await retry.api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), "Result");
  assert.equal(retry.calls.length, 3);
  assert.deepEqual(retry.waits, [625, 1250]);
  assert.ok(retry.calls.every((call) => call.options.signal === retry.calls[0].options.signal));
  assert.ok(retry.calls.every((call) => call.options.body === retry.calls[0].options.body));
  assert.equal(retry.logs.length, 2);
  assert.ok(!JSON.stringify(retry.logs).includes("fake-test-key"));
  assert.ok(!JSON.stringify(retry.logs).includes("private prompt"));
});

test("persistent 503 stops after three attempts and retains sanitized diagnostics", async () => {
  const retry = retryProvider([unavailable]);
  await assert.rejects(retry.api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal), /HTTP 503; UNAVAILABLE/);
  assert.equal(retry.calls.length, 3);
  assert.equal(retry.waits.length, 2);
  assert.equal(retry.logs.length, 3);
});

test("nontransient responses and explicit quota/authentication errors are never retried", async () => {
  for (const [status, providerStatus, reason] of [
    [400, "INVALID_ARGUMENT"], [401, "UNAUTHENTICATED"], [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"], [429, "RESOURCE_EXHAUSTED"], [500, "INTERNAL"],
    [503, "RESOURCE_EXHAUSTED"], [503, "INVALID_ARGUMENT"],
    [503, "UNAVAILABLE", "API_KEY_INVALID"], [503, "UNAVAILABLE", "QUOTA_EXCEEDED"],
  ]) {
    const retry = retryProvider([() => Response.json({ error: { status: providerStatus, details: [{ reason }] } }, { status })]);
    await assert.rejects(retry.api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", new AbortController().signal));
    assert.equal(retry.calls.length, 1);
    assert.equal(retry.waits.length, 0);
  }
});

test("cancellation during backoff stops immediately without another provider call", async () => {
  const abort = new AbortController();
  const retry = retryProvider([unavailable], { abort, onWait: () => abort.abort("private cancellation reason") });
  await assert.rejects(retry.api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", abort.signal), (error) => error.message.includes("timed out or was cancelled") && !error.message.includes("private cancellation reason"));
  assert.equal(retry.calls.length, 1);
  assert.equal(retry.waits.length, 1);
});

test("an already expired run budget prevents every provider attempt", async () => {
  const abort = new AbortController();
  abort.abort();
  const retry = retryProvider([goodResponse]);
  await assert.rejects(retry.api.generateGeminiText("fake-test-key", "gemini-test", "Prompt", "Input", abort.signal), /timed out or was cancelled/);
  assert.equal(retry.calls.length, 0);
});
