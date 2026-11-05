import { RUN_LIMITS, type ExecutionStep, type StepOutput } from "./contracts";

// Provider-neutral executor; production supplies a server-only Gemini caller.
export async function executeSteps({ steps, initialInput, generate, signal, onStep, onOutput }: {
  steps: ExecutionStep[];
  initialInput: string;
  generate: (prompt: string, input: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  onStep: (step: ExecutionStep) => void;
  onOutput: (result: StepOutput) => void;
}): Promise<StepOutput[]> {
  if (!initialInput.trim() || initialInput.length > RUN_LIMITS.initialChars) throw new Error("Enter initial input between 1 and 10,000 characters.");
  if (!steps.length || steps.length > RUN_LIMITS.steps) throw new Error("A chain must have between 1 and 8 steps to run.");
  // Validate the entire chain before making even the first paid request.
  for (const [index, step] of steps.entries()) {
    if (step.step_number !== index + 1 || !step.prompt_text?.trim() || step.prompt_text.length > RUN_LIMITS.promptChars) {
      throw new Error("Steps must be numbered consecutively and contain 1–8,000 characters of prompt text.");
    }
  }
  let input = initialInput;
  const outputs: StepOutput[] = [];
  for (const step of steps) {
    signal.throwIfAborted();
    onStep(step);
    const output = await generate(step.prompt_text, input, signal);
    if (!output.trim() || output.length > RUN_LIMITS.outputChars) throw new Error("The model returned an empty or oversized output. Shorten this step's requested response.");
    const result = { step_id: step.id, step_number: step.step_number, output };
    outputs.push(result);
    onOutput(result);
    input = output;
  }
  return outputs;
}
