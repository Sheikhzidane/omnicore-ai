# Database migrations

Plain SQL, applied in filename order by the Supabase CLI (`supabase db push`).
New files use timestamp versions: `YYYYMMDDHHMMSS_description.sql`.

**Rules**
- Never edit a migration after it has been applied to any environment. Fix forward with a new file.
- Every `public` table: RLS enabled, no `anon` policies, `revoke all … from anon`, indexes on foreign keys.
- Tables that belong to a workspace carry `workspace_id`. Cross-table references use composite `(id, workspace_id)` foreign keys, so a row can never point into another workspace.
- Safety and agent tables are **written by the server only** (service role, after authorisation and an `audit_log` entry). Clients get read access through membership RLS.
- `tests/db/rls.test.mjs` applies every migration to a disposable database and checks these rules. Run it with `TEST_DATABASE_URL=postgres://… npm run test:db`, and **never** against a real project.

## Current chain

| File | Contents |
|---|---|
| `20260923000000_tenancy.sql` | `private` schema, `workspaces`, `workspace_members`, `private.platform_admins`, membership helpers, new-user → personal workspace trigger |
| `20260923000100_audit_log.sql` | append-only `audit_log` |
| `20260923000200_legacy_ops_baseline.sql` | `todos`, `god_status`, `traces`, `subscribers` for the `/ops` dashboard (platform admins only) |
| `20260923000300_characters_safety.sql` | `characters` (disclosure, approval, age, real-person consent), `content_policies`, `platform_publishing_policies` |
| `20260923000400_agent_engine.sql` | `agents`, `agent_tasks`, `agent_runs`, `agent_run_events`, `claim_agent_tasks()` |

## History: why the legacy chain was archived

The inherited Pantheon migrations (`0001`–`0032`) now live **unchanged** in
`supabase/legacy-migrations/`. Applied in order to a fresh Postgres, 14 of the 32 fail:

- invalid SQL: a syntax error in `0020`, an aggregate over a window function in `0011`, a non-immutable index predicate in `0009`
- a call to a function that doesn't exist (`jsonb_each_all`, in `0005`)
- references to tables that were only ever created at runtime in the original author's database (`traces`, `connection_quality_events`, `agent_sql_execution_log`)
- duplicate version numbers (`0005`, `0007`, `0009`, `0011` each appear twice), which `supabase db push` rejects

The chain could never be deployed to a new project, and this fork has never had a live database it was applied to. The Supabase project linked to the owner's account belongs to a different application and was not touched. `20260923000200_legacy_ops_baseline.sql` recreates only the legacy objects the application still reads.

## Live-DB preflight

Every migration starts with a guard that **aborts** if a table it creates already exists, instead of letting `create table if not exists` silently keep an unknown shape. If a guard fires against a real project:

1. Take a schema dump: `supabase db dump --schema public`.
2. Compare the existing table with the one in the migration.
3. Write a forward migration that renames or reshapes the old table. Don't edit the new migration.
