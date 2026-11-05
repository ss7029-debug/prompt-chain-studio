"use client";

import { useActionState, useId, useState, useTransition } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import type { ChainStep } from "@/lib/chain-steps";
import { mutateStep, type StepResult } from "./actions";

const primary = "rounded-full bg-primary px-5 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const secondary = "rounded-full border border-strong-line px-4 py-2 text-sm font-semibold hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
type Operation = "create" | "edit" | "delete" | "up" | "down";
type Selection = { operation: "create" | "edit" | "delete"; step?: ChainStep };

function PromptEditor({ step, onCancel, action, fields }: {
  step?: ChainStep;
  onCancel: () => void;
  action: (data: FormData) => void;
  fields: React.ReactNode;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState(step?.prompt_text ?? "");
  return (
    <form action={action} className="mt-4 space-y-4">
      {fields}
      <div>
        <label htmlFor={id} className="text-sm font-semibold">Prompt text</label>
        <textarea id={id} name="prompt_text" required maxLength={50000} rows={7} value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line bg-field p-3 text-ink focus:outline-2 focus:outline-ring" />
      </div>
      <div className="flex gap-3">
        <button type="submit" className={primary}>{step ? "Save Changes" : "Add Step"}</button>
        <button type="button" className={secondary} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function StepManager({ chainId, steps, loadError }: {
  chainId: string;
  steps: ChainStep[];
  loadError: boolean;
}) {
  const router = useRouter();
  const [active, setActive] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<StepResult | null>(null);
  const [refreshing, refresh] = useTransition();
  const [, action, pending] = useActionState(async (_previous: null, data: FormData) => {
    try {
      const result = await mutateStep(data);
      setNotice(result);
      if (result.success) setActive(null);
    } catch (error) {
      unstable_rethrow(error);
      setNotice({ success: false, message: "Connection interrupted. Refresh the steps to check whether your change was saved before retrying." });
    }
    return null;
  }, null);
  const busy = pending || refreshing;
  const snapshot = JSON.stringify(steps);
  const cancel = () => { setActive(null); setNotice(null); };
  const select = (selection: Selection) => { setNotice(null); setActive(selection); };
  function fields(operation: Operation, step?: ChainStep) {
    return <>
      <input type="hidden" name="chain_id" value={chainId} />
      <input type="hidden" name="operation" value={operation} />
      <input type="hidden" name="expected_steps" value={snapshot} />
      {step && <input type="hidden" name="step_id" value={step.id} />}
    </>;
  }

  return (
    <section className="mt-10" aria-labelledby="steps-heading" aria-busy={busy}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 id="steps-heading" className="text-2xl font-bold">Chain Steps <span className="text-base font-normal">({steps.length})</span></h2>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={secondary} disabled={busy} onClick={() => {
            cancel();
            refresh(() => router.refresh());
          }}>{refreshing ? "Refreshing…" : "Refresh Steps"}</button>
          <button type="button" className={primary} disabled={busy || loadError || active !== null} onClick={() => select({ operation: "create" })}>Add New Step</button>
        </div>
      </div>
      <div aria-live="polite" role="status">
        {pending && <p className="mb-4 text-sm">Saving step changes…</p>}
        {notice && <p role={notice.success ? undefined : "alert"} className={`mb-6 rounded-2xl border border-line bg-surface p-4 ${notice.success ? "" : "text-danger"}`}>{notice.message}</p>}
      </div>
      <fieldset disabled={busy || loadError} className="min-w-0 space-y-4">
        <legend className="sr-only">Manage chain steps</legend>
        {active?.operation === "create" && (
          <div className="rounded-3xl border border-line bg-surface p-6">
            <h3 className="text-xl font-bold">Add New Step</h3>
            <PromptEditor action={action} onCancel={cancel} fields={fields("create")} />
          </div>
        )}
        {!loadError && steps.length === 0 && <p className="rounded-3xl border border-line bg-surface p-8 text-center">No steps yet. Add a prompt to start building this chain.</p>}
        <ol className="space-y-4">
          {steps.map((step, index) => (
            <li key={step.id} className="rounded-3xl border border-line bg-surface p-6 shadow-sm">
              <h3 className="text-xl font-bold">Step {step.step_number ?? "unnumbered"}</h3>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">{step.prompt_text || "No prompt text provided."}</p>
              {active?.step?.id === step.id ? active.operation === "edit" ? (
                <PromptEditor key={step.id} action={action} onCancel={cancel} step={active.step} fields={fields("edit", step)} />
              ) : (
                <form action={action} className="mt-5 space-y-4">
                  {fields("delete", step)}
                  <input type="hidden" name="confirmed" value="yes" />
                  <p>Delete this step? This cannot be undone. Remaining steps will be renumbered.</p>
                  <div className="flex gap-3">
                    <button type="submit" className={primary}>Confirm Delete</button>
                    <button type="button" className={secondary} onClick={cancel}>Cancel</button>
                  </div>
                </form>
              ) : (
                <div className="mt-5 flex flex-wrap gap-3">
                  <button type="button" className={secondary} disabled={active !== null} onClick={() => select({ operation: "edit", step })} aria-label={`Edit step ${step.step_number}`}>Edit</button>
                  <button type="button" className={secondary} disabled={active !== null} onClick={() => select({ operation: "delete", step })} aria-label={`Delete step ${step.step_number}`}>Delete</button>
                  <form action={action}>
                    {fields("up", step)}
                    <button className={secondary} disabled={active !== null || index === 0} aria-label={`Move step ${step.step_number} up`}>Move Up</button>
                  </form>
                  <form action={action}>
                    {fields("down", step)}
                    <button className={secondary} disabled={active !== null || index === steps.length - 1} aria-label={`Move step ${step.step_number} down`}>Move Down</button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ol>
      </fieldset>
    </section>
  );
}
