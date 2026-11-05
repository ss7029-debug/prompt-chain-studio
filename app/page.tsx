
import Link from "next/link";
import ChainManager from "./chain-manager";
import { requireAdmin } from "@/lib/admin";
import { connection } from "next/server";

export const instant = false;

export default async function HomePage() {
  await connection();

  const { supabase, user } = await requireAdmin();

  const { data: chains, error } = await supabase
      .from("prompt_chains")
      .select("id::text, name, description, created_at")
      .order("created_at", { ascending: false });

  return (
      <main className="min-h-screen bg-page px-5 py-12 text-ink">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10">
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-accent">
              ADMIN WORKSPACE
            </p>

            <h1 className="mt-3 text-4xl font-bold md:text-5xl">
              Prompt Chain Studio
            </h1>

            <p className="mt-3 text-muted">
              Design, organize, and run AI-powered prompt chains.
            </p>

            <p className="mt-4 text-sm text-muted">
              Signed in as {user.email}
            </p>
          </div>

          {error && (
              <div className="mb-6 rounded-2xl border border-danger-line bg-field p-5 text-danger">
                Unable to load prompt chains: {error.message}
              </div>
          )}

          <ChainManager chains={chains ?? []} loadError={Boolean(error)} />

          <div className="mt-10">
            <Link
                href="/login"
                className="text-sm font-semibold underline underline-offset-4"
            >
              Login page
            </Link>
          </div>
        </div>
      </main>
  );
}
