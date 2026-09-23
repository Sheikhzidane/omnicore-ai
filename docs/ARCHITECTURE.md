# Architecture

OmniCore is an **AI Influencer Operating System**: one owner runs many fictional AI characters, each with its own content, social accounts, agents, CRM and revenue. This document describes the system after Phase 1. See `MERGE_PLAN.md` for the roadmap.

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js **16.3.6** (App Router, Turbopack), React **19.3**, TypeScript 5 (strict), Tailwind 3.4 |
| Data / auth / storage | **Supabase**: Postgres with RLS, Supabase Auth, Storage |
| AI | Anthropic SDK 0.128 (Claude). Model routing is centralised in Phase 5. |
| Validation | zod |
| Tests | `node:test` + tsx. DB tests run against a disposable Postgres. |
| Legacy ops agents | Node scripts under PM2 (`ecosystem.config.cjs`), disabled by default |

**Not used:** Drizzle and Neon. creator-crm's data layer is translated into Supabase migrations instead.

## Request flow

```
browser ──► proxy.ts ──► route policy (lib/auth/routes.ts)
             │  rate-limit /api/*
             │  Supabase session validated with the Auth server; cookies refreshed
             │  public → pass │ user → session required │ ops → platform admin
             ▼
        app/(os)/layout.tsx  requireWorkspace()  ──► pages (RLS-scoped reads)
        app/(os)/ops/layout  requirePlatformAdmin()
        app/api/**/route.ts  requirePlatformAdminApi / requireWorkspaceApi  (+ audit_log)
             ▼
        Supabase: RLS by workspace membership; server-only writes via the service role
```

## Folder structure

```
app/
  (os)/                    authenticated application shell (sidebar layout)
    dashboard/  characters/[section]  content/[section]  social/[platform]
    agents/[section]  growth/[section]  crm/[section]  monetisation/[section]  settings/
    ops/                   legacy Pantheon dashboard, stream, rpc-errors, share (platform admins)
  login/  auth/callback/  logout/          Supabase Auth
  api/                     legacy ops APIs (all guarded) + future /api/v1 product APIs
  about/ contact/ privacy/ subscribe/ topics/ …   public legacy marketing pages
components/
  shell/                   sidebar, page header, module pages (new)
  *.tsx                    legacy Pantheon dashboard widgets (used by /ops)
lib/
  auth/                    routes (policy), session (RSC), api (route guards), roles, ops-admin
  supabase/                client (browser), server (RSC), request (proxy/route), admin (service role), env
  agents/permissions.ts    character-agent capability model
  safety/                  policy, disclosure, approval (publish gate), audience, prohibited
  config/integrations.ts   integration registry (presence-only status)
  secrets/credentials.ts   AES-256-GCM credential envelope
  social/adapters.ts       platform adapter interface (all DISCONNECTED)
  audit.ts                 append-only audit writes
  nav.ts                   navigation and module sections
supabase/
  migrations/              current chain (timestamped) + README
  legacy-migrations/       inherited 0001–0032, preserved unchanged (not applied)
  tests/bootstrap.sql      local stand-in for Supabase roles/auth (tests only)
scripts/                   legacy ops agents + lib-agent-permissions + check-env-exposure
tests/                     auth, agents, safety, secrets, db (RLS + schema/types)
types/database.ts          Database type (checked against migrations by tests)
docs/                      ARCHITECTURE, SECURITY, AGENT_PERMISSIONS
```

## Database (Phase 1 schema)

```
auth.users ─┬─< workspace_members >── workspaces ──< everything below (workspace_id)
            └── private.platform_admins                    (ops access, server-managed)
workspaces ─< content_policies
           ─< characters ─< agents ─< agent_tasks ─< agent_runs ─< agent_run_events
           ─< platform_publishing_policies (one per platform)
           ─< audit_log (append-only; workspace_id null = platform-level)
legacy ops: todos ─< traces, god_status, subscribers   (platform admins only)
```

- All ids are UUIDs, with `created_at` / `updated_at` timestamps and indexed foreign keys.
- Composite `(id, workspace_id)` FKs keep references inside a workspace.
- New users get one workspace (the V1 single owner) through a trigger. The schema already supports multiple members, with roles `owner`, `admin`, `editor` and `viewer`.
- Tables still to come (per `MERGE_PLAN.md` §6.3): `character_assets`, `social_accounts` and the private credential store, `content`, `content_queue`, `campaigns`, `analytics`, `brands`, `contacts`, `leads`, `outreach`, `deals`, `revenue`.

## Live database state

This fork has **no live database yet**. The inherited migration chain could never be applied to a new project (see `supabase/migrations/README.md`). The only Supabase project on the owner's account belongs to another application and was not touched.

To go live:
1. Create a Supabase project.
2. Run `supabase link` and then `supabase db push`, which applies the 5 migrations in `supabase/migrations/`.
3. Set the env vars in `.env.local.example`.
4. Disable public sign-ups in the Supabase dashboard.
5. Add the owner's email to `AUTH_ALLOWED_EMAILS`, and to `OPS_ADMIN_EMAILS` if you want `/ops` access.

## Quality gates

`npm run lint` · `npm run typecheck` · `npm test` (+ `npm run test:db` with `TEST_DATABASE_URL`) · `npm run build` · `npm run check:secrets`. CI (`.github/workflows/ci.yml`) runs all of them, and the database job runs the RLS suite in a `postgres:16` service container.

## Known debt

- **React Compiler rules:** 31 inherited dashboard files are on `LEGACY_REACT_COMPILER_DEBT` in `eslint.config.mjs` (warnings, not errors). New code gets the full rules.
- 5 pre-existing `react-hooks/exhaustive-deps` warnings and 23 unused-variable warnings, all in legacy code.
- ESLint is pinned to 9 because `eslint-config-next` 16.3.6's bundled plugins don't support ESLint 10 yet.
- There's one low-severity, dev-only esbuild advisory: `tsx` pins it, and it only affects esbuild's Windows dev server.
- The legacy `/ops` APIs depend on the local filesystem and PM2, so they don't work on serverless hosts.
- The 107 legacy SEO pages and the AdSense/Gumroad marketing surface remain public, pending an owner decision.
