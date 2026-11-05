export const runSetupMessage = "Generated results need database setup. Run supabase/sql/prompt-chain-runs.sql in Supabase SQL Editor, then refresh.";

export function runDatabaseError(error: { code?: string; message?: string }): string {
  if (["PGRST202", "PGRST205", "42P01", "42883"].includes(error.code ?? "")) return runSetupMessage;
  if (error.code === "PT429") return error.message || "Run limit reached. Try again later.";
  if (error.code === "22023") return error.message || "Invalid chain input. Check the chain steps.";
  if (error.code === "42501") return "Superadmin access is required to run chains and view results.";
  if (error.code === "PT404") return "The chain or run no longer exists.";
  if (["PT409", "55P03", "40001", "40P01"].includes(error.code ?? "")) return "This run expired or another change is in progress. Refresh the history before trying again.";
  return "Unable to access generated results. Check database setup and try again.";
}
