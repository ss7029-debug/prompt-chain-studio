"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { mutateChain, type ChainActionState } from "./chain-actions";

export type Chain = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
};

const button = "rounded-full bg-primary px-5 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const secondary = "rounded-full border border-strong-line px-4 py-2 text-sm font-semibold hover:bg-page disabled:opacity-50";
const input = "mt-2 w-full rounded-xl border border-line bg-field p-3 text-ink focus:outline-2 focus:outline-ring";

function ChainForm({ operation, chain, onCancel, onSuccess }: {
  operation: "create" | "edit" | "delete";
  chain?: Chain;
  onCancel: () => void;
  onSuccess: (message: string) => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(chain?.name ?? "");
  const [description, setDescription] = useState(chain?.description ?? "");
  const [state, action, pending] = useActionState(async (_previous: ChainActionState, data: FormData) => {
    let result: ChainActionState;
    try {
      result = await mutateChain(data);
    } catch (error) {
      unstable_rethrow(error);
      return { success: false, message: "The request failed. Check your connection and refresh before retrying." };
    }
    if (result.success) onSuccess(result.message);
    return result;
  }, { success: false, message: "" });

  return (
    <form action={action} className="mt-4 space-y-4">
      <input type="hidden" name="operation" value={operation} />
      {chain && <input type="hidden" name="id" value={chain.id} />}
      <fieldset disabled={pending} className="space-y-4">
        {operation === "delete" ? (
          <>
            <input type="hidden" name="confirmed" value="yes" />
            <p>Delete <strong>{chain?.name}</strong>? This cannot be undone.</p>
          </>
        ) : (
          <>
            <div>
              <label htmlFor={`${fieldId}-name`} className="text-sm font-semibold">Name</label>
              <input id={`${fieldId}-name`} name="name" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} className={input} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-description`} className="text-sm font-semibold">Description (optional)</label>
              <textarea id={`${fieldId}-description`} name="description" maxLength={10000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} className={input} />
            </div>
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={button} disabled={pending}>
            {pending ? "Saving…" : operation === "create" ? "Create Chain" : operation === "edit" ? "Save Changes" : "Confirm Delete"}
          </button>
          <button type="button" className={secondary} onClick={onCancel} disabled={pending}>Cancel</button>
        </div>
      </fieldset>
      {state.message && !state.success && <p role="alert" className="text-sm text-danger">{state.message}</p>}
    </form>
  );
}

export default function ChainManager({ chains, loadError }: { chains: Chain[]; loadError: boolean }) {
  const [active, setActive] = useState<{ operation: "create" | "edit" | "delete"; id?: string } | null>(null);
  const [message, setMessage] = useState("");
  function complete(message: string) {
    setMessage(message);
    setActive(null);
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Your Prompt Chains</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-surface px-4 py-2 text-sm font-semibold">{chains.length} chains</span>
          <button className={button} disabled={active !== null} onClick={() => { setMessage(""); setActive({ operation: "create" }); }}>Create New Chain</button>
        </div>
      </div>
      <div role="status" aria-live="polite">
        {message && <p className="mb-6 rounded-2xl border border-line bg-surface p-4">{message}</p>}
      </div>
      {active?.operation === "create" && (
        <section className="mb-6 rounded-3xl border border-line bg-surface p-6">
          <h3 className="text-xl font-bold">Create New Chain</h3>
          <ChainForm operation="create" onCancel={() => setActive(null)} onSuccess={complete} />
        </section>
      )}
      {!loadError && chains.length === 0 && (
        <div className="rounded-3xl border border-line bg-surface p-10 text-center">
          <h3 className="text-xl font-bold">No prompt chains yet</h3>
          <p className="mt-3 text-muted">Select Create New Chain to get started.</p>
        </div>
      )}
      {!loadError && <div className="grid gap-4 md:grid-cols-2">
        {chains.map((chain) => (
          <article key={chain.id} className="min-w-0 rounded-3xl border border-line bg-surface p-6 shadow-sm">
            <h3 className="break-words text-xl font-bold">{chain.name}</h3>
            <Link href={`/chains/${chain.id}`} className="mt-3 inline-block text-sm font-semibold underline underline-offset-4">Open Chain →</Link>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted">{chain.description || "No description provided."}</p>
            <p className="mt-5 text-xs text-subtle">Created {new Date(chain.created_at).toLocaleDateString()}</p>
            {active?.id === chain.id ? (
              <ChainForm key={active.operation} operation={active.operation} chain={chain} onCancel={() => setActive(null)} onSuccess={complete} />
            ) : (
              <div className="mt-5 flex gap-3">
                <button className={secondary} disabled={active !== null} onClick={() => { setMessage(""); setActive({ operation: "edit", id: chain.id }); }} aria-label={`Edit ${chain.name}`}>Edit</button>
                <button className={secondary} disabled={active !== null} onClick={() => { setMessage(""); setActive({ operation: "delete", id: chain.id }); }} aria-label={`Delete ${chain.name}`}>Delete</button>
              </div>
            )}
          </article>
        ))}
      </div>}
    </>
  );
}
