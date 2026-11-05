import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { isDatabaseId, type ChainStep } from "@/lib/chain-steps";
import StepManager from "./step-manager";
import ChainRunner from "./chain-runner";
import { loadRunHistory } from "./history-actions";
import { geminiConfiguration } from "@/lib/ai/gemini";

export const instant = false;

export default async function ChainPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { supabase } = await requireAdmin();
  const { id } = await params;
  if (!isDatabaseId(id)) notFound();
  const { data: chain, error: chainError } = await supabase.from("prompt_chains")
    .select("id::text, name, description").eq("id", id).maybeSingle();
  if (!chainError && !chain) notFound();

  // Fetch every page; a truncated snapshot must never drive a reorder or deletion.
  const steps: ChainStep[] = [];
  let loadError = Boolean(chainError);
  if (chain) {
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.from("prompt_chain_steps")
        .select("id::text, step_number, prompt_text")
        .eq("prompt_chain_id", id)
        .order("step_number", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true }).range(offset, offset + 499);
      if (error || !data) { loadError = true; break; }
      steps.push(...data);
      if (data.length === 0) break;
      offset += data.length;
    }
  }

  const history = chain ? await loadRunHistory(id, 0) : { runs: [], hasMore: false };
  let configurationError: string | undefined;
  try { geminiConfiguration(); } catch (error) { configurationError = (error as Error).message; }

  return (
    <main className="min-h-screen bg-page px-5 py-12 text-ink">
      <div className="mx-auto max-w-4xl">
        <Link href="/" className="text-sm font-semibold underline underline-offset-4">← Back to chains</Link>
        <p className="mt-8 text-xs font-bold uppercase tracking-[0.3em] text-accent">CHAIN WORKSPACE</p>
        <h1 className="mt-3 break-words text-4xl font-bold">{chain?.name ?? "Prompt chain"}</h1>
        {chain?.description && <p className="mt-3 whitespace-pre-wrap break-words text-muted">{chain.description}</p>}
        {loadError && <p role="alert" className="mt-6 rounded-2xl border border-danger-line bg-surface p-5 text-danger">Unable to load this chain and its steps. Refresh to try again.</p>}
        <StepManager chainId={id} steps={loadError ? [] : steps} loadError={loadError} />
        <ChainRunner chainId={id} stepCount={steps.length} disabled={loadError} configurationError={configurationError} initialHistory={history} />
      </div>
    </main>
  );
}
