"use server";

import { requireAdmin } from "@/lib/admin";
import { isDatabaseId } from "@/lib/chain-steps";
import type { RunRecord } from "@/lib/ai/contracts";
import { runDatabaseError } from "@/lib/ai/database-errors";

const pageSize = 5;

export async function loadRunHistory(chainId: string, page: number): Promise<{ runs: RunRecord[]; hasMore: boolean; error?: string }> {
  const { supabase } = await requireAdmin();
  if (!isDatabaseId(chainId) || !Number.isSafeInteger(page) || page < 0 || page > 10000) {
    return { runs: [], hasMore: false, error: "Invalid history page." };
  }
  try {
    const { data, error } = await supabase.from("prompt_chain_runs")
      .select("id, prompt_chain_id::text, chain_name, initial_input, model, status, steps_snapshot, step_outputs, final_output, error_message, created_at, finished_at")
      .eq("prompt_chain_id", chainId)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize);
    if (error) return { runs: [], hasMore: false, error: runDatabaseError(error) };
    const runs = ((data ?? []).slice(0, pageSize) as RunRecord[]).map((run) => ({
      ...run, expired: run.status === "running" && Date.now() - new Date(run.created_at).getTime() > 300000,
    }));
    return { runs, hasMore: (data?.length ?? 0) > pageSize };
  } catch {
    return { runs: [], hasMore: false, error: "Unable to load history. Check your connection and try again." };
  }
}
