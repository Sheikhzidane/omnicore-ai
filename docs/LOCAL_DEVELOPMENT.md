# Local development

## Prerequisites

- Node.js 22 and npm
- Docker (for the local Supabase stack)
- Supabase CLI: <https://supabase.com/docs/guides/cli>

## First run

```bash
npm ci
cp .env.example .env.local

supabase init          # creates supabase/config.toml (local only; keep the existing migrations)
supabase start         # local Postgres, Auth, Storage and Studio in Docker
supabase db reset      # applies supabase/migrations to the LOCAL database
```

Copy the `API URL`, `anon key` and `service_role key` printed by `supabase start` into `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Then set these in `.env.local`:

```
NEXT_PUBLIC_SITE_URL=http://localhost:3000
AUTH_ALLOWED_EMAILS=you@example.com
CREDENTIALS_ENCRYPTION_KEY=<openssl rand -base64 32>
CRON_SECRET=<openssl rand -hex 32>
```

Run the app:

```bash
npm run dev            # http://localhost:3000
```

Sign in with a magic link. The local Supabase stack catches emails in **Inbucket/Mailpit**; the URL is printed by `supabase start`.

## Working without AI keys

Set `AI_PROVIDER_MODE=mock` in `.env.local` to use labelled fake providers:
- text is prefixed `[MOCK]`
- images are a 1×1 PNG

To exercise agent flows end to end, also set `AGENTS_ENABLED=true` and enable agents in the Control Centre. **Mock mode is refused in production builds.**

## Running the scheduler locally

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/publish
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/agents
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/metrics
```

## Checks (the same as CI)

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:secrets            # after a build
npm run check:committed-secrets
# Migration + RLS suite against a disposable Postgres (never a real project):
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres npm run test:db
```

`54322` is the local Supabase database port. Any throwaway Postgres 16 also works; the suite creates and drops its own databases.

## Useful paths

| Path | What |
|---|---|
| `supabase/migrations/README.md` | what each migration does |
| `types/database.ts` | generated types (`npm run db:types`) |
| `lib/agents/definitions.ts` | the 15 agents and their tasks |
| `lib/social/providers/` | platform integrations |
| `tests/` | unit, route and database tests |
