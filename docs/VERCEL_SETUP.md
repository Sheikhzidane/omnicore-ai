# Vercel setup

Omnicore is a standard Next.js app. Vercel builds it from the GitHub repository. Nothing in the repository deploys automatically: you create the project and trigger deployments yourself.

## 1. Create the project

1. Go to <https://vercel.com/new>. Import **Sheikhzidane/omnicore-ai**.
2. **Framework preset:** Next.js. Leave the build command (`next build`) and output settings at their defaults.
3. **Production branch:** `main`. Merge the build branch into `main` when you are ready to go live.
4. Before the first deploy, add the environment variables (step 2). Otherwise the first build succeeds but the app cannot sign anyone in.

> If a Vercel project already exists for another app, do not reuse it. Create a new project for Omnicore.

## 2. Environment variables

Go to **Project → Settings → Environment Variables**. Add each variable from `docs/ENVIRONMENT.md` that is marked **Vercel required** for the features you use. Minimum set:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`: your production URL, no trailing slash
- `AUTH_ALLOWED_EMAILS`
- `CREDENTIALS_ENCRYPTION_KEY` and `CRON_SECRET`: generate both, never reuse them
- `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`: for AI features

Tips:
- Mark secrets as **Sensitive** so their values cannot be read back in the dashboard.
- Use different values for **Preview** and **Production**, or leave Preview without service keys. Preview deployments are reachable by anyone with the URL.
- **Never** set `AI_PROVIDER_MODE=mock` in Vercel. The app refuses to run providers in mock mode in production.

## 3. Scheduled jobs (Vercel Cron)

`vercel.json` declares three cron jobs:

| Path | Schedule | What it does |
|---|---|---|
| `/api/cron/publish` | every 5 minutes | publishes approved posts whose time has come; retries with backoff |
| `/api/cron/agents` | every 15 minutes | runs queued agent tasks. Does nothing unless `AGENTS_ENABLED=true`. |
| `/api/cron/metrics` | daily at 03:17 UTC | pulls post metrics from connected platforms |

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set. Without it, every cron call is refused (HTTP 503).

> **Plan limits.** Vercel's **Hobby** plan only allows cron jobs that run once a day, and deployments with more frequent schedules are rejected. On Hobby, do one of the following:
> - **Upgrade to Pro.** Recommended; publishing then happens within 5 minutes of the scheduled time.
> - **Edit `vercel.json`** to daily schedules, e.g. change `"*/5 * * * *"` to `"5 8 * * *"`. Posts then publish at most once a day.
> - **Keep the daily schedule and add an external scheduler** that calls `GET https://<domain>/api/cron/publish` with the header `Authorization: Bearer <CRON_SECRET>` every 5 minutes.
>
> Check the current limits at <https://vercel.com/docs/cron-jobs/usage-and-pricing>.

The cron routes declare `maxDuration = 60` seconds. Hobby may cap function duration lower. Each cycle processes a small batch, so a timeout only delays work to the next run.

## 4. Domain

Go to **Project → Settings → Domains** to add your domain. Then update:
- `NEXT_PUBLIC_SITE_URL` in Vercel
- Supabase **Site URL** and **Redirect URLs** (`docs/SUPABASE_SETUP.md` §4)
- every social app's **OAuth redirect URI** (`docs/SOCIAL_INTEGRATIONS.md`)

Redeploy after changing environment variables. Vercel only applies them to new deployments.

## 5. Verify

After deploying:
1. Open `https://<domain>/login` and sign in with an allow-listed email.
2. Open **Settings → Integrations**. Each integration you configured should show **configured**.
3. Run `curl -i https://<domain>/api/cron/publish`. It must return **401**, because no secret was sent. A **503** means `CRON_SECRET` is missing.
4. In **Vercel → Project → Cron Jobs**, the three jobs should be listed.
