# Vercel 3 — Scheduling and your domain

## Scheduling

Omnicore publishes approved posts through Vercel Cron: `vercel.json` sets a 5-minute schedule for publishing.

- **Vercel Pro:** nothing to do. After deploying, **Project → Settings → Cron Jobs** lists three jobs.
- **Vercel Hobby (free):** Hobby only allows jobs that run once a day, and it rejects deployments with more frequent jobs. Either upgrade to Pro, or ask your developer to switch `vercel.json` to daily schedules (see docs/VERCEL_SETUP.md §3).

Check that it is protected: open `https://YOUR-DOMAIN/api/cron/publish` in a browser. You should see `{"error":"unauthorized"}`. If you see `cron not configured`, `CRON_SECRET` is missing.

## Domain (optional)

1. Go to **Project → Settings → Domains → Add** and follow Vercel's DNS instructions.
2. Update `NEXT_PUBLIC_SITE_URL` in Vercel to the new address and redeploy.
3. Update Supabase **Site URL** and **Redirect URLs** (Supabase guide 3).
4. Update the redirect URL in every social app you created (social guides).
