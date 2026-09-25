# Vercel 2 — Environment variables

Open **Project → Settings → Environment Variables**. For each row, click **Add**. Paste the name and the value, and tick **Production** (and **Preview** if you want previews to work). For anything marked secret, tick **Sensitive**.

| Name | Value | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | no |
| `SUPABASE_URL` | the same Project URL | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → API → anon public key | no |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → service_role key | **yes** |
| `NEXT_PUBLIC_SITE_URL` | your live address, no `/` at the end | no |
| `AUTH_ALLOWED_EMAILS` | your email (add team emails, comma separated) | keep private |
| `CREDENTIALS_ENCRYPTION_KEY` | generate one (see below) | **yes** |
| `CRON_SECRET` | generate one (see below) | **yes** |
| `AGENTS_ENABLED` | `false` for now | no |

Generating the two random secrets:
- **On a Mac or Linux terminal:** run `openssl rand -base64 32` for `CREDENTIALS_ENCRYPTION_KEY`, and `openssl rand -hex 32` for `CRON_SECRET`.
- **On Windows (PowerShell 7+):** `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`. Run it twice, one value for each secret.
- **Save both values in your password manager.** Losing `CREDENTIALS_ENCRYPTION_KEY` means reconnecting every social account.

Add AI and social keys later, using their own guides. Then go to **Deployments** and click **Redeploy** on the latest deployment, so the new variables are applied.

⚠️ Never add `AI_PROVIDER_MODE` in Vercel.
