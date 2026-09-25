# Deployment

Deployment is **manual and owner-driven**: no CI job deploys, and nothing in the repository touches a live database or Vercel project. For a plain-language, tick-box version of this guide, see `MANUAL_DEPLOYMENT_CHECKLIST.md`.

## Order of operations

1. **Supabase.** Create a dedicated Omnicore project, apply the migrations and configure Auth. See [SUPABASE_SETUP.md](SUPABASE_SETUP.md).
2. **Secrets.** Generate `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`) and `CRON_SECRET` (`openssl rand -hex 32`). Store both in a password manager.
3. **Vercel.** Create the project from GitHub and add the environment variables. See [VERCEL_SETUP.md](VERCEL_SETUP.md) and [ENVIRONMENT.md](ENVIRONMENT.md).
4. **Deploy.** Merge the build branch into `main`, or trigger a deployment from the Vercel dashboard.
5. **First sign-in.** Sign in at `/login` with an email from `AUTH_ALLOWED_EMAILS`. Your workspace is created automatically.
6. **Policies.** In **Settings → Publishing Policies**, enable each platform you will use. Keep **Requires human approval** on.
7. **AI.** Add `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`. **Settings → AI Providers** shows which features are active. See [AI_PROVIDERS.md](AI_PROVIDERS.md).
8. **Characters.** In **Characters → Create**, run the wizard. The 15 agents are created **disabled**.
9. **Social.** Register each platform's developer app, add its env vars, redeploy, then **Social Accounts → Connect**. See [SOCIAL_INTEGRATIONS.md](SOCIAL_INTEGRATIONS.md).
10. **Agents (optional).** Enable the agents you want in **AI Agents → Control Centre**, then set `AGENTS_ENABLED=true` and redeploy.
11. **Verify.** Work through the verification list below. Record the results in `BUILD_REPORT.md`.

## Verification after each deployment

| Check | Expected |
|---|---|
| `GET /login` | Sign-in page |
| `GET /dashboard` while signed out | Redirect to `/login` |
| Sign in with an email **not** in `AUTH_ALLOWED_EMAILS` | Generic failure message |
| `GET /api/cron/publish` without a header | `401` (or `503` if `CRON_SECRET` is unset, which must be fixed) |
| `POST /api/social-webhooks/instagram` with no signature | `401` |
| `POST /api/webhooks/stripe` with no signature | `401` |
| Settings → Integrations | Everything you configured shows **configured** |
| Settings → AI Providers | No "mock" banner |
| Vercel → Cron Jobs | three jobs listed |

## Rolling back

- **Application:** in Vercel, open **Deployments**, choose a previous deployment and click **Promote to Production**.
- **Database:** migrations are forward-only. Fix problems with a new migration. For data recovery, use Supabase backups or PITR.
- **Stopping all agents immediately:** set `AGENTS_ENABLED=false` and redeploy. Each agent can also be disabled individually in the Control Centre, which takes effect without a redeploy.
- **Stopping publishing immediately:** turn off **Publishing enabled** in Settings → Publishing Policies. The next cycle blocks queued jobs with the reason recorded.

## What this repository never does

- It never runs `supabase db push`, `db reset` or `link` against a hosted project, in CI or in tests.
- It never deploys from CI.
- It never stores real credentials. `.env.example` has empty values, and CI fails if a key-shaped string is committed.
