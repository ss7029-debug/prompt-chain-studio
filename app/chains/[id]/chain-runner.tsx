"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { RUN_LIMITS, type RunEvent, type RunRecord, type StepOutput } from "@/lib/ai/contracts";
import { loadRunHistory } from "./history-actions";

const primary = "rounded-full bg-primary px-5 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const secondary = "rounded-full border border-strong-line px-4 py-2 text-sm font-semibold hover:bg-page disabled:opacity-50";
const panel = "rounded-3xl border border-line bg-surface p-6 shadow-sm";
type History = { runs: RunRecord[]; hasMore: boolean; error?: string };

function OutputList({ outputs }: { outputs: StepOutput[] }) {
  return <div className="mt-4 space-y-3">{outputs.map((result) => (
    <details key={result.step_id} className="rounded-xl border border-line p-4">
      <summary className="cursor-pointer font-semibold">Step {result.step_number} output</summary>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm">{result.output}</pre>
    </details>
  ))}</div>;
}

export default function ChainRunner({ chainId, stepCount, disabled, configurationError, initialHistory }: {
  chainId: string;
  stepCount: number;
  disabled: boolean;
  configurationError?: string;
  initialHistory: History;
}) {
  const [initialInput, setInitialInput] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [outputs, setOutputs] = useState<StepOutput[]>([]);
  const [finalOutput, setFinalOutput] = useState("");
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState(initialHistory);
  const [page, setPage] = useState(0);
  const [refreshing, refresh] = useTransition();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  function fetchHistory(nextPage: number) {
    refresh(async () => {
      try {
        const result = await loadRunHistory(chainId, nextPage);
        setHistory(result);
        setPage(nextPage);
      } catch (failure) {
        unstable_rethrow(failure);
        setHistory({ runs: [], hasMore: false, error: "Unable to load history. Refresh and try again." });
      }
    });
  }

  async function run(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true); setError(""); setOutputs([]); setFinalOutput(""); setSaved(false); setProgress("Starting chain…");
    let terminal = false;
    let received: StepOutput[] = [];
    let total = stepCount;
    try {
      const response = await fetch(`/chains/${chainId}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialInput }), signal: controller.signal,
      });
      if (response.redirected) throw new Error("Your session changed. Reload the page and sign in again.");
      if (!response.ok) {
        let message = "Unable to start the chain.";
        try { const data = await response.json(); if (typeof data.error === "string") message = data.error; } catch { /* Use the generic error. */ }
        throw new Error(message);
      }
      if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) throw new Error("Unexpected server response. Refresh history before retrying.");
      function handle(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as RunEvent;
        if (event.type === "started") { total = event.total; setProgress(`Running ${total} steps…`); }
        if (event.type === "step") setProgress(`Running step ${event.number} of ${event.total}…`);
        if (event.type === "output") {
          received = [...received, event.result];
          setOutputs(received);
          setProgress(received.length === total ? "Saving generated results…" : `Step ${event.result.step_number} completed…`);
          if (received.length === total) setFinalOutput(event.result.output);
        }
        if (event.type === "completed") {
          terminal = true; setSaved(true); setFinalOutput(event.output); setProgress("Chain completed and saved to history.");
        }
        if (event.type === "error") {
          terminal = true; setError(event.message); setProgress(event.saved ? "Failed run recorded in history." : "Check history before retrying.");
        }
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 524288) throw new Error("Response exceeded the display limit. Refresh history to check the saved run.");
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            handle(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) handle(buffer);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!terminal) throw new Error("The connection ended before completion was confirmed. Refresh history before retrying.");
    } catch (failure) {
      setError(controller.signal.aborted ? "Run stopped. A request already sent to Gemini may still incur usage. Refresh history before starting another run."
        : failure instanceof Error ? failure.message : "Unable to complete this chain. Refresh history before retrying.");
      setProgress("");
    } finally {
      abort.current = null; setRunning(false); fetchHistory(0);
    }
  }

  return (
    <>
      <section aria-labelledby="run-heading" className={`mt-10 ${panel}`}>
        <h2 id="run-heading" className="text-2xl font-bold">Run Chain</h2>
        <p className="mt-3 text-sm text-muted">Each prompt receives the previous step’s output. Runs use a snapshot of the saved steps.</p>
        <p className="mt-2 text-xs text-subtle">Up to 8 steps, 8,000 prompt characters per step, and 2,048 output tokens per step. Five runs per administrator per hour.</p>
        {configurationError && <p className="mt-4 text-sm text-danger">{configurationError}</p>}
        {history.error && <p className="mt-4 text-sm text-danger">{history.error}</p>}
        {!disabled && (stepCount === 0 || stepCount > RUN_LIMITS.steps) && <p className="mt-4 text-sm text-danger">Add between 1 and 8 steps before running this chain.</p>}
        <form onSubmit={run} className="mt-5 space-y-4">
          <label htmlFor="chain-initial-input" className="block text-sm font-semibold">Initial text input</label>
          <textarea id="chain-initial-input" value={initialInput} onChange={(event) => setInitialInput(event.target.value)}
            rows={5} required maxLength={RUN_LIMITS.initialChars} disabled={running}
            className="w-full rounded-xl border border-line bg-field p-3 focus:outline-2 focus:outline-ring" />
          <p className="text-xs text-subtle">{initialInput.length.toLocaleString()} / 10,000 characters</p>
          <div className="flex gap-3">
            <button className={primary} disabled={running || disabled || !!configurationError || !!history.error || !initialInput.trim() || stepCount === 0 || stepCount > RUN_LIMITS.steps}>{running ? "Running…" : "Run Chain"}</button>
            {running && <button type="button" className={secondary} onClick={() => abort.current?.abort()}>Stop Run</button>}
          </div>
        </form>
        <p role="status" aria-live="polite" className="mt-4 text-sm">{progress}</p>
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
        {finalOutput && <div className="mt-6">
          <h3 className="text-xl font-bold">Final Output</h3>
          <p className="mt-2 text-xs">{saved ? "Saved to history." : "Save not confirmed. Copy this output or check history before leaving."}</p>
          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm">{finalOutput}</pre>
        </div>}
        <OutputList outputs={outputs} />
      </section>
      <section aria-labelledby="history-heading" className="mt-10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 id="history-heading" className="text-2xl font-bold">Generated Results</h2>
          <button type="button" className={secondary} disabled={refreshing || running} onClick={() => fetchHistory(0)}>{refreshing ? "Refreshing…" : "Refresh History"}</button>
        </div>
        {history.error && <p role="alert" className={`${panel} text-danger`}>{history.error}</p>}
        {!history.error && history.runs.length === 0 && <p className={panel}>No generated results yet. Run this chain to save its first result.</p>}
        <div className="space-y-4">{history.runs.map((record) => {
          const expired = record.expired;
          return <details key={record.id} className={panel}>
            <summary className="cursor-pointer font-semibold">{new Date(record.created_at).toLocaleString()} · {expired ? "Interrupted / expired" : record.status}</summary>
            <p className="mt-3 text-xs text-subtle">{record.model} · {record.steps_snapshot.length} steps</p>
            <h3 className="mt-4 font-semibold">Initial input</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{record.initial_input}</p>
            {record.final_output && <><h3 className="mt-4 font-semibold">Final output</h3><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{record.final_output}</pre></>}
            {(record.error_message || expired) && <p className="mt-4 text-sm text-danger">{record.error_message || "This run did not finish within five minutes. You can start another run; unavailable partial outputs cannot be recovered."}</p>}
            <OutputList outputs={record.step_outputs} />
            <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Prompts used for this run</summary>
              {record.steps_snapshot.map((step) => <p key={step.id} className="mt-3 whitespace-pre-wrap break-words text-sm"><strong>Step {step.step_number}:</strong> {step.prompt_text}</p>)}
            </details>
          </details>;
        })}</div>
        <div className="mt-5 flex items-center gap-3">
          <button className={secondary} disabled={refreshing || running || page === 0} onClick={() => fetchHistory(page - 1)}>Previous</button>
          <span className="text-sm">Page {page + 1}</span>
          <button className={secondary} disabled={refreshing || running || !history.hasMore} onClick={() => fetchHistory(page + 1)}>Next</button>
        </div>
      </section>
    </>
  );
}
