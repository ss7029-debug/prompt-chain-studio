export const RUN_LIMITS = {
  initialChars: 10000,
  promptChars: 8000,
  steps: 8,
  outputChars: 12000,
  outputTokens: 2048,
  stepTimeoutMs: 30000,
  runTimeoutMs: 180000,
} as const;

export type ExecutionStep = { id: string; step_number: number; prompt_text: string };
export type StepOutput = { step_id: string; step_number: number; output: string };
export type RunRecord = {
  id: string;
  prompt_chain_id: string | null;
  chain_name: string;
  initial_input: string;
  model: string;
  status: "running" | "completed" | "failed";
  steps_snapshot: ExecutionStep[];
  step_outputs: StepOutput[];
  final_output: string | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  expired?: boolean;
};
export type RunEvent =
  | { type: "started"; runId: string; total: number }
  | { type: "step"; number: number; total: number }
  | { type: "output"; result: StepOutput }
  | { type: "completed"; runId: string; output: string }
  | { type: "error"; message: string; step?: number; saved: boolean };
