# OmniCore: AI Influencer Operating System

Create fictional AI characters, connect their social accounts, run AI agents for them, approve content, grow their audience, and manage their brand deals and revenue, across many characters from one workspace.

> **Status: Phase 1 complete (secure foundation).** Authentication, multi-tenant-ready database security, agent lockdown, secrets handling, safety foundations and the application shell are built. Feature modules (characters, CRM, content, agents, growth, monetisation) arrive in later phases; see [MERGE_PLAN.md](MERGE_PLAN.md). Nothing in the UI is simulated: unbuilt modules and integrations say so.

## Principles

- **Human in control.** Human approval is the default for every publish and outreach action. Agents are disabled until you turn them on.
- **Honest AI.** Every character carries AI disclosure, which can't be switched off. Sponsored content always carries `#ad`. Characters must be fictional; a real-person likeness needs recorded consent.
- **No growth hacks.** There is no mass DM-ing, fake engagement, follow/unfollow automation or rate-limit evasion. These are excluded by design, not by configuration.
- **No fake integrations.** Instagram, TikTok, YouTube and X show **DISCONNECTED / NOT CONFIGURED** until real credentials and OAuth connections exist.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 3 · Supabase (Postgres + RLS, Auth, Storage) · Anthropic Claude · zod. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

```bash
npm ci
cp .env.local.example .env.local      # fill in Supabase keys; everything else is optional
# Create a Supabase project, then apply the schema:
npx supabase link --project-ref <ref>
npx supabase db push                  # applies supabase/migrations/*
npm run dev                           # http://localhost:3000 → /login
```

Then:
1. In the Supabase dashboard, **disable public sign-ups** and add `http://localhost:3000/auth/callback` (and your production URL) to the redirect URLs.
2. Put your email in `AUTH_ALLOWED_EMAILS` (V1 is single-owner). Add it to `OPS_ADMIN_EMAILS` if you want the legacy `/ops` console.
3. Sign in at `/login`. Your workspace is created automatically.

## Quality gates

```bash
npm run lint          # ESLint 9 flat config (next core-web-vitals + typescript)
npm run typecheck     # tsc --noEmit
npm test              # unit + agent-permission + safety + secrets tests
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db   # migrations + RLS (disposable DB only!)
npm run build
npm run check:secrets # after build: no server secret can reach the client bundle
```

CI runs all of these. The database job uses a throwaway `postgres:16` container.

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) and [docs/AGENT_PERMISSIONS.md](docs/AGENT_PERMISSIONS.md). In short:
- Supabase Auth, with identity validated by the Auth server.
- The workspace is always derived from membership, never taken from client input.
- RLS on every table, with no anonymous access.
- Privileged actions are authorised server-side and written to an append-only audit log.
- Server secrets never use `NEXT_PUBLIC_`.
- Social tokens are encrypted at rest (AES-256-GCM).

## Legacy: Pantheon

This repository began as a fork of [Pantheon](https://github.com/lewisallena17/pantheon), an autonomous self-improving agent dashboard (MIT, © lewisallena17). Its operations console is preserved at **`/ops`** (platform admins only), and its agents are **disabled by default and sandboxed**. They can no longer modify auth, RLS, migrations, env files, secrets, packages, deployment config or their own code, and they can't push to git. The original marketing pages remain under `/topics` pending review.

creator-crm (MIT, © Creator CRM contributors) is the reference for the upcoming CRM module. Its concepts are being translated into this Supabase architecture; its code is not copied wholesale. See [MERGE_PLAN.md](MERGE_PLAN.md).

## License

MIT. See [LICENSE](LICENSE).
