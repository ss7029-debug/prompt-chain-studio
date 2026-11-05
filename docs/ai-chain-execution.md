# AI chain execution and generated history

## Setup required before a live run

No production SQL or real Gemini request was executed by Codex.

1. Review the **complete** script in `supabase/sql/prompt-chain-runs.sql` and run it
   manually in the existing project's Supabase SQL Editor as the database owner.
   It creates a new `public.prompt_chain_runs` table, indexes, a superadmin-only
   SELECT policy, and the `begin_prompt_chain_run` / `finish_prompt_chain_run` RPCs.
   It does not modify the existing NYC Unlocked result tables or assume their
   columns. It also leaves existing authentication and step management SQL intact.
   The script intentionally fails and rolls back if the table already exists;
   inspect an existing table before attempting to adapt the script.
2. Add `GEMINI_API_KEY` **locally** in `.env.local`. Do not paste it into chat or
   put it in a `NEXT_PUBLIC_` variable. Preserve your working Supabase variables.
   `.env.example` shows names only; `.env*` files are ignored except that example.
3. Optionally set `GEMINI_MODEL`. The default is `gemini-3.5-flash-lite`.
   Confirm your Gemini account has access. Model details:
   https://aistudio.google.com/docs/models/gemini-3.5-flash-lite
   The server calls the documented REST generateContent endpoint without an
   additional SDK or new dependencies:
   https://aistudio.google.com/api-reference/generate-content
4. Restart `npm run dev`, sign in as a superadmin, and open a chain.

The page shows setup errors while the key or table/functions are missing. The
Run Chain control stays disabled when a known setup error exists. The server
also checks configuration and reserves the run in the database before making
any paid model calls. A failed reservation never falls back to an unsaved run.

## Test the full chain

1. Create a chain or use NYC Adventure Creator with two short steps, for example:
   - Step 1: `Suggest three NYC activities matching the input. Keep it under 150 words.`
   - Step 2: `Turn the supplied activities into a concise morning-to-evening itinerary. Keep it under 200 words.`
2. In Run Chain, enter `A relaxed Saturday for two people who enjoy parks and art.`
3. Click Run Chain. Verify the display identifies the running step, then shows
   intermediate output and the final result. Expand each step output.
4. Verify the completion message says the run was saved. Reload the page and
   expand its entry in Generated Results. Check initial input, final output,
   intermediate outputs and the exact prompt snapshot. History has five runs
   per page and Previous/Next controls.
5. Edit a chain step and run again. The old entry should retain its original
   prompt snapshot and outputs.
6. Test an empty chain or one over the limits: it must fail before Gemini is
   called. To test a provider failure safely, temporarily configure a nonexistent
   `GEMINI_MODEL`, restart, and verify a clear error with no later steps executed.
   Restore the model and restart afterward. Accepted failed runs count toward quotas.
7. Stop a run and refresh history. A request already sent to Google may still be
   billed. Interrupted runs may remain marked running until five minutes have
   elapsed; a later admission marks expired records failed. The UI also identifies
   expired entries on history refresh. Do not repeatedly submit retries after an
   ambiguous connection failure; review history first.
8. Verify the existing chain and step Create/Edit/Delete/Move controls still work.
   Unauthenticated users redirect to login, and nonadmins cannot run chains,
   write run records or read history.

## Limits and execution behavior

- Initial input: 1–10,000 characters.
- Chain: 1–8 steps, numbered consecutively, with 1–8,000 prompt characters each.
- Each step: at most 2,048 output tokens and 12,000 visible output characters.
- Each Gemini request: 30-second deadline. Whole chain: 3-minute deadline.
- One active run per administrator, five accepted runs per administrator/hour,
  and twenty accepted runs across the workspace/hour. Database admission locking
  makes these limits work across tabs, processes and servers.
- No automatic provider retries, continuations, tools, or parallel step execution.
  Every step receives its saved prompt as the system instruction and exactly
  the prior output as user input; only the first step receives the initial input.
- Token-truncated, blocked, empty or oversized model results stop the chain.
  They are never silently used as complete input for the next step.

A run reserves its snapshot in a short database transaction, using the same
parent chain lock as step management. Editing afterward does not change that
run. Completion saves the entire set of outputs atomically. A handled failure
records its earlier outputs and failing step. History is plain escaped text;
model output is not executed or rendered as HTML.

If saving cannot be confirmed, the UI keeps generated outputs visible and does
not claim success. Copy them before leaving and refresh history. A server crash
or hard hosting timeout can lose unsaved intermediate outputs; this is a bounded
request-based executor, not a durable job queue or resumable worker. Configure
hosting to allow the requested 240-second route duration and stream responses;
a shorter platform timeout still takes precedence. A new run can be admitted
once an abandoned reservation is older than five minutes.

History and run writes require superadmin authorization. The RPCs perform their
own explicit `auth.uid()` / `profiles.is_superadmin` check with an empty search
path and qualified table references. Direct authenticated writes to the new
table are revoked; only authenticated RPC execution is granted. The app uses
its existing user-scoped Supabase client, with no service-role key. Gemini keys
exist only in the server-only provider module, are sent in a header, and are
never logged or returned. Raw provider response bodies/errors are not logged.

Deleting a chain preserves its historical run records, name and prompt snapshot
and clears their foreign key. The deleted chain no longer has a detail page;
those retained records are accessible through authorized database inspection.
Keeping them also preserves hourly quota accounting. The script does not add
retention cleanup or change any existing table policies.

## Verification

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build -- --webpack` (default Turbopack is blocked by this environment's
  local-port restriction)
- `node --test tests/ai-execution.test.mjs`
- `node --test tests/chain-runs.test.mjs tests/step-management.test.mjs`

The provider and route tests use fake keys, mocked requests and mocked database
clients. SQL tests run the exact migration in isolated disposable local
PostgreSQL clusters (initdb, pg_ctl and psql on PATH). They never read production
environment values or connect to Supabase. A real end-to-end test still requires
manual SQL installation, local Gemini configuration and your signed-in session.
