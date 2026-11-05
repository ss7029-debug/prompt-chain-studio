"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { isDatabaseId, stepSetupMessage } from "@/lib/chain-steps";

export type StepResult = { success: boolean; message: string };

export async function mutateStep(formData: FormData): Promise<StepResult> {
  const { supabase } = await requireAdmin();
  const chainId = formData.get("chain_id");
  const stepId = formData.get("step_id");
  const operation = formData.get("operation");
  const prompt = formData.get("prompt_text");
  const expected = formData.get("expected_steps");
  if (!isDatabaseId(chainId) || typeof operation !== "string"
    || !["create", "edit", "delete", "up", "down"].includes(operation)
    || (operation !== "create" && !isDatabaseId(stepId))) {
    return { success: false, message: "Invalid chain, step, or operation. Refresh and try again." };
  }
  if (operation === "delete" && formData.get("confirmed") !== "yes") {
    return { success: false, message: "Confirm deletion before continuing." };
  }
  if ((operation === "create" || operation === "edit")
    && (typeof prompt !== "string" || !prompt.trim() || prompt.length > 50000)) {
    return { success: false, message: "Enter prompt text between 1 and 50,000 characters." };
  }
  let snapshot: unknown;
  try {
    snapshot = typeof expected === "string" ? JSON.parse(expected) : null;
    if (!Array.isArray(snapshot) || !snapshot.every((step) => step && isDatabaseId(step.id)
      && (step.step_number === null || Number.isInteger(step.step_number))
      && (step.prompt_text === null || typeof step.prompt_text === "string"))) {
      return { success: false, message: "Invalid step snapshot. Refresh and try again." };
    }
  } catch {
    return { success: false, message: "Invalid step snapshot. Refresh and try again." };
  }

  try {
    const { error } = await supabase.rpc("manage_prompt_chain_steps", {
      p_chain_id: chainId,
      p_operation: operation,
      p_step_id: operation === "create" ? null : stepId,
      p_prompt_text: operation === "create" || operation === "edit" ? prompt : null,
      p_expected_steps: snapshot,
    });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") {
        return { success: false, message: stepSetupMessage };
      }
      if (["PT409", "40001", "40P01", "55P03"].includes(error.code)) {
        return { success: false, message: "Steps changed or another administrator is updating this chain. Refresh the steps, review the latest version, and try again." };
      }
      if (error.code === "PT404") {
        return { success: false, message: "The chain or step no longer exists. Refresh the steps." };
      }
      if (error.code === "42501") {
        return { success: false, message: "You do not have permission to change these steps." };
      }
      if (error.code === "22023") {
        return { success: false, message: "Invalid prompt text or move. Refresh the steps and try again." };
      }
      console.error("Step mutation failed:", error.code, error.message);
      return { success: false, message: "Unable to save step changes. No partial changes were saved. Please try again." };
    }
  } catch {
    // A disconnected client cannot know whether a transaction committed; don't retry blindly.
    return { success: false, message: "Connection interrupted. Refresh the steps to check whether your change was saved before retrying." };
  }

  revalidatePath(`/chains/${chainId}`);
  const verb = operation === "create" ? "added" : operation === "edit" ? "updated" : operation === "delete" ? "deleted" : "moved";
  return { success: true, message: `Step ${verb} successfully.` };
}
