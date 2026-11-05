
"use client";

import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
    async function signInWithGoogle() {
        const supabase = createClient();

        const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: `${window.location.origin}/auth/callback`,
            },
        });

        if (error) {
            alert("Unable to sign in: " + error.message);
        }
    }

    return (
        <main className="flex min-h-screen items-center justify-center bg-page px-5 text-ink">
            <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-8 text-center shadow-lg">
                <p className="text-xs font-bold uppercase tracking-widest text-accent">
                    PROMPT CHAIN STUDIO
                </p>

                <h1 className="mt-4 text-3xl font-bold">
                    Admin Sign In
                </h1>

                <p className="mt-3 text-sm leading-6 text-muted">
                    Sign in with your authorized Google account
                    to manage prompt chains.
                </p>

                <button
                    type="button"
                    onClick={signInWithGoogle}
                    className="mt-7 w-full rounded-2xl bg-primary px-6 py-4 font-semibold text-on-primary transition hover:bg-primary-hover"
                >
                    Continue with Google
                </button>
            </div>
        </main>
    );
}
