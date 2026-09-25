# Environment variables

`.env.example` lists every variable with a one-line comment. For local development copy it to `.env.local`, which git ignores. On Vercel, set each variable under **Project → Settings → Environment Variables**.

Rules:
- A variable starting with `NEXT_PUBLIC_` is shipped to every browser. Never give a secret that prefix. `npm run check:secrets` fails the build if a server secret reaches client code.
- Settings → Integrations and Settings → AI Providers show which variables are **set**. They never show values.
- "Configured" means the value is present. It does not mean the value works.

Key to the columns:
- **Local required?** / **Vercel required?**
  - **Yes** — the app will not run without it.
  - **Feature** — needed only for the feature named in the Purpose column.
  - **No** — optional.

## Core

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (browser + server) | Public | Supabase → Project Settings → API → Project URL | Yes | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key; RLS protects the data | Public | Supabase → Project Settings → API → `anon` `public` key | Yes | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side writes after authorisation; bypasses RLS | **Secret** | Supabase → Project Settings → API → `service_role` key | Yes | Yes |
| `SUPABASE_URL` | Same URL, for server code and legacy scripts | Public | Same as `NEXT_PUBLIC_SUPABASE_URL` | Yes | Yes |
| `NEXT_PUBLIC_SITE_URL` | Base URL for magic links and OAuth redirect URIs (no trailing slash) | Public | `http://localhost:3000` locally; your Vercel/custom domain in production | Yes | Yes |
| `AUTH_ALLOWED_EMAILS` | Comma-separated emails allowed to sign in (no public sign-up) | Secret-ish (not a credential, keep private) | You choose | Yes | Yes |
| `OPS_ADMIN_EMAILS` | Emails allowed into the legacy `/ops` dashboard | Private | You choose | No | No |

## Security

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | AES-256-GCM key for stored social OAuth tokens (and the OAuth state cookie) | **Secret** | Generate: `openssl rand -base64 32`. Store it in a password manager: if it is lost, every account must be reconnected. | Feature (social accounts) | Feature (social accounts) |
| `CRON_SECRET` | Authenticates Vercel Cron calls to `/api/cron/*`; unset means every cron call is refused | **Secret** | Generate: `openssl rand -hex 32` | Feature (scheduling) | Feature (scheduling) |
| `AGENTS_ENABLED` | Global kill switch for agents; must be exactly `true` | Public (not sensitive) | You choose (`false` by default) | No | No |

## AI providers

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | Text generation for agents and drafting; fallback moderation provider | **Secret** | console.anthropic.com → API Keys | Feature (agents) | Feature (agents) |
| `ANTHROPIC_MODEL` | Override for the capable model (default `claude-opus-5`) | Public | Anthropic model list | No | No |
| `ANTHROPIC_FAST_MODEL` | Override for the fast model (default `claude-haiku-4-5`) | Public | Anthropic model list | No | No |
| `OPENAI_API_KEY` | Images, video, moderation and embeddings; optional text provider | **Secret** | platform.openai.com → API keys | Feature (images/moderation) | Feature (images/moderation) |
| `OPENAI_TEXT_MODEL` | Text model; required only when `AI_TEXT_PROVIDER=openai` | Public | OpenAI model list | No | No |
| `OPENAI_FAST_TEXT_MODEL` | Fast text model (defaults to `OPENAI_TEXT_MODEL`) | Public | OpenAI model list | No | No |
| `OPENAI_IMAGE_MODEL` | Image model (default `gpt-image-1`) | Public | OpenAI model list | No | No |
| `OPENAI_VIDEO_MODEL` | Video model (default `sora-2`) | Public | OpenAI model list | No | No |
| `OPENAI_MODERATION_MODEL` | Moderation model (default `omni-moderation-latest`) | Public | OpenAI model list | No | No |
| `OPENAI_EMBEDDING_MODEL` | Embedding model (default `text-embedding-3-small`) | Public | OpenAI model list | No | No |
| `AI_TEXT_PROVIDER` | `anthropic` or `openai`; blank = Anthropic if its key is set | Public | You choose | No | No |
| `AI_IMAGE_PROVIDER` | `openai` or `none` | Public | You choose | No | No |
| `AI_VIDEO_PROVIDER` | `openai` to opt in to video generation | Public | You choose | No | No |
| `AI_MODERATION_PROVIDER` | `openai`, `anthropic` or `none`. With none, all content needs human review. | Public | You choose | No | No |
| `AI_EMBEDDING_PROVIDER` | `openai` or `none` | Public | You choose | No | No |
| `AI_PROVIDER_MODE` | `mock` gives labelled fake outputs for local development; **refused in production** | Public | You choose | No | **Must be unset** |

## Social platforms

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `META_APP_ID` | Instagram OAuth (Instagram API with Instagram Login) | Public-ish (app id) | developers.facebook.com → your app → Instagram → API setup with Instagram login | Feature (Instagram) | Feature (Instagram) |
| `META_APP_SECRET` | Instagram token exchange and webhook signatures | **Secret** | Same page (Instagram app secret) | Feature (Instagram) | Feature (Instagram) |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token for the Meta webhook subscription handshake | **Secret** | You generate it; paste the same value into the Meta webhook settings | No | Feature (Instagram comments) |
| `TIKTOK_CLIENT_KEY` | TikTok OAuth | Public-ish | developers.tiktok.com → your app | Feature (TikTok) | Feature (TikTok) |
| `TIKTOK_CLIENT_SECRET` | TikTok token exchange and webhook signatures | **Secret** | Same page | Feature (TikTok) | Feature (TikTok) |
| `TIKTOK_PRIVACY_LEVEL` | Post visibility; keep `SELF_ONLY` until TikTok audits your app | Public | You choose after the audit | No | No |
| `GOOGLE_OAUTH_CLIENT_ID` | YouTube OAuth | Public-ish | console.cloud.google.com → APIs & Services → Credentials | Feature (YouTube) | Feature (YouTube) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | YouTube token exchange | **Secret** | Same page | Feature (YouTube) | Feature (YouTube) |
| `YOUTUBE_PRIVACY_STATUS` | `private` (default), `unlisted` or `public`; unverified projects are forced private | Public | You choose after verification | No | No |
| `X_CLIENT_ID` | X OAuth 2.0 | Public-ish | developer.x.com → your app → Keys and tokens → OAuth 2.0 | Feature (X) | Feature (X) |
| `X_CLIENT_SECRET` | X token exchange (confidential client) | **Secret** | Same page | Feature (X) | Feature (X) |
| `X_CONSUMER_SECRET` | X Account Activity webhook CRC and signatures (the API key secret) | **Secret** | Same page → Consumer keys | No | Feature (X mentions) |

## Payments and email

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | Verifies `/api/webhooks/stripe` so revenue is recorded only from genuine events | **Secret** | Stripe Dashboard → Developers → Webhooks → endpoint → Signing secret (`whsec_…`) | No | Feature (Stripe revenue) |
| `RESEND_API_KEY` | Sends outreach emails a human has approved | **Secret** | resend.com → API Keys | No | Feature (email outreach) |
| `OUTREACH_FROM_EMAIL` | Sender address on a domain verified in Resend | Public | resend.com → Domains | No | Feature (email outreach) |

## Legacy `/ops` dashboard (optional)

The `/ops` area is inherited from the earlier Pantheon project. It is available only to platform admins, and the product does not depend on it. It reads additional optional variables such as `GITHUB_TOKEN`, `GITHUB_REPO`, `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `DEV_TO_API_KEY`, `GUMROAD_ACCESS_TOKEN`, `ELEVENLABS_API_KEY` and `PUSHOVER_TOKEN`. Leave them unset unless you use `/ops`.

| VARIABLE | PURPOSE | SECRET/PUBLIC | WHERE TO OBTAIN IT | LOCAL REQUIRED? | VERCEL REQUIRED? |
|---|---|---|---|---|---|
| `OPS_AGENTS_ENABLED` | Allows the legacy ops agent scripts to run (process env) | Public | You choose (`false`) | No | No |
| `OPS_AGENT_CODE_WRITES` | Allows legacy agents to edit legacy UI files | Public | You choose (`false`) | No | No |
| `GITHUB_WEBHOOK_SECRET` | Signature secret for `/api/webhooks/github` | **Secret** | GitHub repo → Settings → Webhooks | No | No |
| `GENERIC_WEBHOOK_TOKEN` | Token for `/api/webhooks/generic` | **Secret** | You generate it | No | No |

## Set automatically (do not set)

`NODE_ENV`, `VERCEL` and `VERCEL_*` are set by Next.js and Vercel.
