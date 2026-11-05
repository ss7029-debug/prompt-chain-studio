export type ChainStep = {
  id: string;
  step_number: number | null;
  prompt_text: string | null;
};

// IDs stay strings throughout: PostgreSQL bigint can exceed JavaScript's safe integers.
export function isDatabaseId(value: unknown): value is string {
  return typeof value === "string" && /^-?\d{1,19}$/.test(value)
    && BigInt(value) >= BigInt("-9223372036854775808")
    && BigInt(value) <= BigInt("9223372036854775807");
}

export const stepSetupMessage = "Step management needs database setup. Run supabase/sql/prompt-chain-steps.sql in Supabase SQL Editor, then refresh this page.";
