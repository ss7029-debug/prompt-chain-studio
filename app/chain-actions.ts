"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";

export type ChainActionState = { success: boolean; message: string };

export async function mutateChain(formData: FormData): Promise<ChainActionState> {
  const { supabase } = await requireAdmin();
  const operation = formData.get("operation");
  const id = formData.get("id");
  const name = formData.get("name");
  const description = formData.get("description");

  if (operation !== "create" && operation !== "edit" && operation !== "delete") {
    return { success: false, message: "Invalid chain action." };
  }
  if (operation !== "create" && (typeof id !== "string" || !id.trim())) {
    return { success: false, message: "A chain ID is required." };
  }
  if (operation === "delete" && formData.get("confirmed") !== "yes") {
    return { success: false, message: "Please confirm deletion first." };
  }
  if (operation !== "delete") {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
      return { success: false, message: "Enter a chain name between 1 and 200 characters." };
    }
    if (typeof description !== "string" || description.length > 10000) {
      return { success: false, message: "Description must be at most 10,000 characters." };
    }
  }

  try {
    const table = supabase.from("prompt_chains");
    const values = {
      name: typeof name === "string" ? name.trim() : "",
      description: typeof description === "string" ? description.trim() : "",
    };
    const query = operation === "create"
      ? table.insert(values)
      : operation === "edit"
        ? table.update(values).eq("id", id as string)
        : table.delete().eq("id", id as string);
    // Returning the affected ID also detects missing rows or writes blocked by RLS.
    const { data, error } = await query.select("id");
    if (error) {
      console.error(`Unable to ${operation} prompt chain:`, error);
      return { success: false, message: `Unable to ${operation === "edit" ? "update" : operation} the chain. Please try again.` };
    }
    if (!data?.length) {
      return { success: false, message: "No chain was changed. It may have been deleted or you may not have permission. Refresh and try again." };
    }
  } catch (error) {
    console.error("Prompt chain mutation failed:", error);
    return { success: false, message: "Unable to reach the database. Please try again." };
  }

  revalidatePath("/");
  return {
    success: true,
    message: `Chain ${operation === "create" ? "created" : operation === "edit" ? "updated" : "deleted"} successfully.`,
  };
}
