# OmniCore: AI Influencer Operating System

Create fictional AI characters, connect their social accounts, run AI agents for them, approve content, grow their audience, and manage their brand deals and revenue, across many characters from one workspace.

> **Status: full product build complete in the repository; not yet deployed.** All modules are built and tested: characters, content studio, approvals, publishing, social accounts, 15 agents, growth, engagement, monetisation and settings. Live deployment and live platform verification are owner steps. See [BUILD_REPORT.md](BUILD_REPORT.md) for the exact status of every part, and [MANUAL_DEPLOYMENT_CHECKLIST.md](MANUAL_DEPLOYMENT_CHECKLIST.md) to go live.

## Principles

- **Human in control.** Human approval is the default for every publish and outreach action. Agents are disabled until you turn them on.
- **Honest AI.** Every character carries AI disclosure, which can't be switched off. Sponsored content always carries `#ad`. Characters must be fictional; a real-person likeness needs recorded consent.
- **No growth hacks.** There is no mass DM-ing, fake engagement, follow/unfollow automation or rate-limit evasion. These are excluded by design, not by configuration.
- **No fake integrations or numbers.** Instagram, TikTok, YouTube and X show **NOT CONFIGURED / not connected** until real credentials and OAuth connections exist. Analytics show only platform-reported or imported data.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 3 · Supabase (Postgres + RLS, Auth, Storage) · provider-neutral AI (Anthropic, OpenAI) · Vercel Cron · zod. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started

- **Local development:** [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md). It uses a local Supabase stack in Docker and never touches a hosted project.
- **Going live:** [MANUAL_DEPLOYMENT_CHECKLIST.md](MANUAL_DEPLOYMENT_CHECKLIST.md), backed by [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md), [docs/VERCEL_SETUP.md](docs/VERCEL_SETUP.md) and `setup/manual/`.
- **Environment variables:** [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) and `.env.example`.
- **Integrations:** [docs/SOCIAL_INTEGRATIONS.md](docs/SOCIAL_INTEGRATIONS.md), [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md).
- **Taking over the codebase:** [docs/HANDOVER.md](docs/HANDOVER.md).

```bash
npm ci
cp .env.example .env.local
npm run dev                           # http://localhost:3000 → /login
```

## Quality gates

```bash
npm run lint
npm run typecheck
npm test                                  # unit, route, agent, safety, social, UI-coverage tests
TEST_DATABASE_URL=postgres://… npm run test:db   # migrations + RLS (disposable DB only!)
npm run build
npm run check:secrets                     # after build: no server secret can reach the client bundle
npm run check:committed-secrets           # no keys or real project URLs in tracked files
```

CI runs all of these. The database job uses a throwaway `postgres:16` container. **CI never deploys.**

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

creator-crm (MIT, © Creator CRM contributors) was the reference for the brand-deal module (contacts, leads, deals). Its concepts were translated into this Supabase architecture; its code was not copied. See [MERGE_PLAN.md](MERGE_PLAN.md).

## License

MIT. See [LICENSE](LICENSE).
