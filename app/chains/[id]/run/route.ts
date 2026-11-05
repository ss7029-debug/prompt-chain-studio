import { requireAdmin } from "@/lib/admin";
import { isDatabaseId } from "@/lib/chain-steps";
import { RUN_LIMITS, type ExecutionStep, type RunEvent, type StepOutput } from "@/lib/ai/contracts";
import { runDatabaseError } from "@/lib/ai/database-errors";
import { executeSteps } from "@/lib/ai/execute";
import { geminiConfiguration, generateGeminiText } from "@/lib/ai/gemini";

export const maxDuration = 240;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route handlers need an explicit same-origin check for cookie-authenticated POSTs.
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Run requests must come from this application." }, { status: 403 });
  }
  const { supabase } = await requireAdmin();
  const { id } = await params;
  if (!isDatabaseId(id)) return Response.json({ error: "Invalid chain ID." }, { status: 400 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Expected a JSON request." }, { status: 400 });
  }
  let initialInput: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new Error(); }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    const data = JSON.parse(body);
    if (typeof data.initialInput !== "string" || !data.initialInput.trim() || data.initialInput.length > RUN_LIMITS.initialChars) throw new Error();
    initialInput = data.initialInput;
  } catch {
    return Response.json({ error: "Enter initial input between 1 and 10,000 characters." }, { status: 400 });
  }
  let config: ReturnType<typeof geminiConfiguration>;
  try { config = geminiConfiguration(); } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }

  // Reserve a durable, quota-checked run before spending anything on Gemini.
  let reservation;
  try {
    const { data, error } = await supabase.rpc("begin_prompt_chain_run", {
      p_chain_id: id, p_initial_input: initialInput, p_model: config.model,
    });
    if (error) return Response.json({ error: runDatabaseError(error) }, { status: error.code === "PT429" ? 429 : 400 });
    reservation = data as { id: string; steps: ExecutionStep[] };
    if (!reservation?.id || !Array.isArray(reservation.steps)) throw new Error();
  } catch {
    return Response.json({ error: "Unable to start the run. Refresh history before retrying; no AI request was made." }, { status: 503 });
  }
  const run = reservation;
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal, AbortSignal.timeout(RUN_LIMITS.runTimeoutMs)]);
  const encoder = new TextEncoder();
  const outputs: StepOutput[] = [];
  let currentStep: number | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: RunEvent) {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { cancelled.abort(); }
      }
      async function save(status: "completed" | "failed", message: string | null) {
        try {
          const { error } = await supabase.rpc("finish_prompt_chain_run", {
            p_run_id: run.id, p_status: status, p_outputs: outputs, p_error: message,
          });
          return error ? runDatabaseError(error) : null;
        } catch { return "The save response was interrupted. Refresh history to check whether results were saved."; }
      }
      send({ type: "started", runId: run.id, total: run.steps.length });
      try {
        await executeSteps({
          steps: run.steps, initialInput, signal,
          generate: (prompt, input, stepSignal) => generateGeminiText(config.apiKey, config.model, prompt, input, stepSignal),
          onStep: (step) => { currentStep = step.step_number; send({ type: "step", number: step.step_number, total: run.steps.length }); },
          onOutput: (result) => { outputs.push(result); send({ type: "output", result }); },
        });
        signal.throwIfAborted();
        const saveError = await save("completed", null);
        if (saveError) {
          send({ type: "error", step: currentStep, message: `Generation finished, but saving was not confirmed. ${saveError} Keep or copy the outputs below.`, saved: false });
        } else {
          send({ type: "completed", runId: run.id, output: outputs[outputs.length - 1].output });
        }
      } catch (error) {
        const reason = signal.aborted ? "Run cancelled or the three-minute time limit was reached."
          : error instanceof Error ? error.message : "The chain could not finish.";
        const message = `${currentStep ? `Step ${currentStep}: ` : ""}${reason}`.slice(0, 500);
        const saveError = await save("failed", message);
        send({ type: "error", step: currentStep, message: saveError ? `${message} Failure history could not be confirmed. ${saveError}` : message, saved: !saveError });
      } finally {
        try { controller.close(); } catch { /* The client disconnected. */ }
      }
    },
    cancel() { cancelled.abort(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
