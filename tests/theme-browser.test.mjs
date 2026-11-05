// Production browser smoke tests. Requires `npm run build -- --webpack` first.
// Uses a fresh Chrome profile and public pages only; never authenticates or calls AI.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const chromePath = process.env.CHROME_BINARY || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("production browser themes", { skip: !existsSync(chromePath) }, () => {
  let server, chrome, directory, socket, origin;
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  function send(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async function evaluate(session, expression) {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (response.exceptionDetails) throw new Error("Browser evaluation failed");
    return response.result.value;
  }
  async function waitFor(session, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(session, expression)) return;
      await delay(50);
    }
    throw new Error("Browser condition timed out");
  }
  async function page(url = "/login", media = "light") {
    const target = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: media }] }, sessionId);
    await send("Page.navigate", { url: origin + url }, sessionId);
    await hydrated(sessionId);
    return sessionId;
  }
  async function hydrated(session) {
    await waitFor(session, `!!document.getElementById('theme-preference') && Object.keys(document.getElementById('theme-preference')).some(k=>k.startsWith('__reactProps'))`);
  }
  async function reload(session) {
    await evaluate(session, "window.__themeTestReload=true");
    await send("Page.reload", {}, session);
    await waitFor(session, "!window.__themeTestReload && !!document.querySelector('main')");
  }
  async function select(session, theme) {
    await evaluate(session, `(()=>{const s=document.getElementById('theme-preference');s.value=${JSON.stringify(theme)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(session, `document.documentElement.dataset.theme===${JSON.stringify(theme)} && document.getElementById('theme-preference').value===${JSON.stringify(theme)}`);
  }
  const background = (session) => evaluate(session, "getComputedStyle(document.querySelector('main')).backgroundColor");

  before(async () => {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
    });
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(origin + "/login")).ok; } catch { /* Wait for startup. */ }
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, "Production server must start");
    directory = await mkdtemp(path.join(tmpdir(), "chain-theme-chrome-"));
    const endpoint = await new Promise((resolve, reject) => {
      chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
      const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
      chrome.on("error", () => { clearTimeout(timer); reject(new Error("Chrome could not launch")); });
      chrome.stderr.on("data", (chunk) => {
        const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(`Browser command rejected: ${message.error.code}`));
        else item.resolve(message.result);
      }
      if (message.method === "Runtime.exceptionThrown") errors.push("runtime exception");
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
        if (/hydrat|didn't match|does not match|Minified React error/i.test(text)) errors.push("hydration error");
      }
    });
  }, { timeout: 40000 });

  after(async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      await send("Browser.close").catch(() => {});
      socket.close();
    }
    chrome?.kill();
    if (server) { const exited = new Promise((resolve) => server.once("exit", resolve)); server.kill(); await exited; }
    if (chrome && chrome.exitCode === null) await new Promise((resolve) => chrome.once("exit", resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("Light/Dark selector updates colors and survives refresh and navigation", async () => {
    const session = await page();
    await select(session, "light");
    assert.equal(await background(session), "rgb(245, 213, 223)");
    await select(session, "dark");
    assert.equal(await background(session), "rgb(33, 24, 32)");
    assert.equal(await evaluate(session, "getComputedStyle(document.querySelector('main > div')).backgroundColor"), "rgb(48, 35, 44)");
    await waitFor(session, "getComputedStyle(document.querySelector('main button')).color==='rgb(40, 28, 38)'");
    await reload(session);
    await hydrated(session);
    await waitFor(session, "document.getElementById('theme-preference').value==='dark'");
    assert.equal(await background(session), "rgb(33, 24, 32)");
    await send("Page.navigate", { url: origin + "/unauthorized" }, session);
    await hydrated(session);
    assert.equal(await background(session), "rgb(33, 24, 32)");
    await select(session, "light");
    assert.equal(await background(session), "rgb(245, 213, 223)");
  });

  test("System follows live OS changes and explicit Light/Dark override them", async () => {
    const session = await page();
    await select(session, "system");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, session);
    assert.equal(await background(session), "rgb(33, 24, 32)");
    await select(session, "light");
    assert.equal(await background(session), "rgb(245, 213, 223)");
    await select(session, "dark");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, session);
    assert.equal(await background(session), "rgb(33, 24, 32)");
    await select(session, "system");
    assert.equal(await background(session), "rgb(245, 213, 223)");
  });

  test("separate tabs synchronize and dark is applied before hydration scripts load", async () => {
    const first = await page();
    const second = await page("/unauthorized");
    await select(first, "dark");
    await waitFor(second, "document.documentElement.dataset.theme==='dark' && document.getElementById('theme-preference').value==='dark'");
    await send("Network.enable", {}, first);
    await send("Network.setBlockedURLs", { urls: ["*/_next/static/chunks/*"] }, first);
    await reload(first);
    await waitFor(first, "!!document.querySelector('main') && document.readyState==='complete'");
    assert.equal(await background(first), "rgb(33, 24, 32)");
    await send("Network.setBlockedURLs", { urls: [] }, first);
    const image = await send("Page.captureScreenshot", { format: "png" }, first);
    await writeFile(path.join(tmpdir(), "prompt-chain-theme-dark.png"), Buffer.from(image.data, "base64"));
  });

  test("blocked browser storage falls back to System and allows in-tab selection", async () => {
    const session = await page();
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage blocked')}})" }, session);
    await reload(session);
    await hydrated(session);
    await waitFor(session, "document.getElementById('theme-preference').value==='system'");
    await select(session, "dark");
    assert.equal(await background(session), "rgb(33, 24, 32)");
  });

  test("no theme-related hydration errors or browser exceptions", () => {
    assert.deepEqual(errors, []);
  });
});
