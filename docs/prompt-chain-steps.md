# Prompt chain steps

## One-time manual setup

Before testing Add, Edit, Delete, Move Up or Move Down, open
`supabase/sql/prompt-chain-steps.sql`, copy its **entire contents**, and run it in
your existing project's Supabase SQL Editor as the database owner (`postgres`).
The application does not install this function, and it has not been installed by
Codex. No existing tables, constraints, policies, authentication code or Supabase
configuration are changed by the script. Existing data is not modified on install.

The new `public.manage_prompt_chain_steps` function runs each mutation in one
transaction. It verifies `auth.uid()` against `public.profiles.is_superadmin`, uses
an empty search path with qualified table references, and revokes public/anonymous
execution. All calls from the app also pass through `requireAdmin()` and use the
existing signed-in user's Supabase client. No secret or service-role key is needed.

Each RPC locks the superadmin profile and the parent chain, then locks the child
rows. App mutations for the same chain serialize, and a complete expected snapshot
rejects stale tabs rather than overwriting other edits. IDs are passed as strings
to preserve PostgreSQL bigint precision. Step numbers are normalized to 1..N after
successful mutations. Equal/null existing positions are ordered deterministically
by step number (nulls last), then ID. This relies on the confirmed absence of a
unique `(prompt_chain_id, step_number)` constraint.

Keep future application step writes on this RPC. Independent manual SQL or other
applications must coordinate their transactions too; this script deliberately
does not change existing table grants, RLS policies, constraints or triggers.
Reading chains and steps continues to use the existing table SELECT/RLS access.

If the function is missing, mutations show a database setup message without
falling back to separate unsafe writes. On a conflict, refresh and review the
latest steps before retrying. Refresh closes an open editor; copy any draft text
you want to preserve first. On a connection failure, refresh to check whether the
transaction committed before retrying.

## Manual test

1. Run the installation SQL above, then run `npm run dev` and sign in as a superadmin.
2. Open **NYC Adventure Creator** with **Open Chain** on the dashboard.
3. Add three steps with distinct prompt text. Verify step numbers 1, 2 and 3.
4. Edit step 2, save, then reload to check persistence.
5. Move step 2 up and then down. Verify text moves with its step and numbering
   remains consecutive. The first Up and last Down controls are disabled.
6. Click Delete, test Cancel, then Confirm Delete. Verify the remaining steps are
   numbered 1 and 2. Delete the final steps and test adding to an empty chain.
7. Open the same chain in two tabs. Change steps in one tab, then attempt a change
   in the other without refreshing. Verify it reports a conflict and preserves
   the saved data. Refresh the second tab to review the new order before retrying.
8. Confirm existing dashboard chain Create/Edit/Delete controls still work and
   unauthenticated/non-superadmin users cannot access the chain workspace.

## Local verification

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build -- --webpack` (default Turbopack is blocked by the execution
  environment's local-port restriction).
- `node --test tests/step-management.test.mjs`

The SQL tests require local PostgreSQL `initdb`, `pg_ctl` and `psql` on PATH. They
create an isolated temporary cluster with mocked auth and fixtures, test the exact
installation SQL, stop the cluster, and remove its temporary files. They never use
`.env.local` or connect to Supabase. Tests cover CRUD, moves, gap/duplicate repair,
empty chains, stale snapshots, invalid inputs, cross-chain targeting, unauthorized
access, rollback after deletion, and concurrent mutations. Live Supabase testing
still requires you to install the function and use your authenticated session.
