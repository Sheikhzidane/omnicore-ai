# Social integrations

Instagram, TikTok, YouTube and X each have their own provider in `lib/social/providers/`. All four use the **official API with the platform's own OAuth**.

**Status: IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED.** Each provider follows the platform's published API. Its OAuth URLs, token exchange, publish flow, metrics and webhook signature checks are unit-tested against recorded request shapes (`tests/social/providers.test.ts`). **None has yet been exercised against the live platform from this codebase.** Connect a test account and publish a private test post on each platform before relying on it.

## What the integrations can and cannot do

| | Instagram | TikTok | YouTube | X |
|---|---|---|---|---|
| Connect via OAuth | ✓ | ✓ | ✓ (PKCE) | ✓ (PKCE) |
| Publish image | ✓ single image | ✓ photo post | — | ✓ single image |
| Publish video | ✓ Reel | ✓ | ✓ | — (not implemented) |
| Text-only post | — | — | — | ✓ |
| Carousel / multiple images | — (not implemented) | ✓ photo carousel | — | — (not implemented) |
| Post metrics | ✓ insights | ✓ | ✓ statistics | ✓ public metrics |
| Webhooks → Engagement inbox | ✓ comments, mentions | ✓ post status events (logged) | — | ✓ mentions/replies (Account Activity API) |
| Reply to comments (after approval) | ✓ | — | ✓ | ✓ |
| AI-content label | caption disclosure | `is_aigc: true` + caption | `containsSyntheticMedia: true` + description | caption disclosure |
| Sponsored label | `#ad` in caption | `brand_content_toggle` + `#ad` | `paidProductPlacementDetails` + `#ad` | `#ad` in caption |

**Never implemented, by design:**
- direct messages
- following or unfollowing
- likes
- scraping
- account rotation
- anything that evades rate limits

See `lib/safety/prohibited.ts`.

## How connecting works

1. An admin opens **Social Accounts** and clicks **Connect** for a character.
2. `/api/social/connect/<platform>` does three things:
   - creates or reuses the character's account row, with status `pending`
   - seals `{state, PKCE verifier, workspace, account, user, expiry}` into an httpOnly cookie, encrypted with `CREDENTIALS_ENCRYPTION_KEY`
   - redirects to the platform
3. The platform redirects back to `/api/social/callback/<platform>`. The callback accepts the code only when the state matches, the same signed-in user started the flow, and less than 10 minutes have passed.
4. The code is exchanged for tokens. The token bundle is **encrypted in the app** (AES-256-GCM) and stored through the service-role-only RPC `store_social_credential`, in `private.social_credential_secrets`. Only non-secret metadata goes into public tables: scopes, expiry and status.
5. Tokens are refreshed automatically when they are within 5 minutes of expiry. If a refresh fails, the account is marked `error` and must be reconnected.

## Publishing path

1. **Approval queue.** Approving a post creates a `publishing_jobs` row with status `queued`, a unique idempotency key and the approval id.
2. **Cron cycle.** Every 5 minutes, `/api/cron/publish` claims due jobs with `SKIP LOCKED`.
3. **Publish-time checks.** Each gate is re-checked for the claimed job:
   - is the version the one that was approved?
   - is safety still `passed`?
   - are the disclosures present?
   - is the account connected?
   - is the policy enabled?
   - are the daily limit and minimum interval respected?
   - are the app credentials present?
4. **Publish.** The provider's `publish()` is called with short-lived signed Storage URLs.
5. **Result:**
   - Success is recorded once. A unique index allows only one success per job.
   - Temporary errors retry with exponential backoff: 5, 10, 20 minutes …
   - Permanent errors (unsupported format, revoked token, policy) mark the job `blocked`, with the reason shown in **Publishing Queue**.

## Per-platform setup

The step-by-step guides are in `setup/manual/social/`. In short:

### Instagram (Meta)

- **Account:** an Instagram **Professional** (Business or Creator) account.
- **App:** create an app at developers.facebook.com and add the **Instagram API with Instagram Login** product.
- **Permissions:** `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`. Publishing to accounts other than your own test users requires **App Review**.
- **OAuth redirect URI:** `https://<domain>/api/social/callback/instagram`
- **Webhook:** callback URL `https://<domain>/api/social-webhooks/instagram`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to `comments` and `mentions`.
- **Env:** `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`
- **Limits:** 100 API-published posts per 24 hours. Media must be fetchable by Meta over HTTPS; Omnicore gives it 1-hour signed URLs.

### TikTok

- **App:** create an app at developers.tiktok.com with **Login Kit** and **Content Posting API → Direct Post**.
- **Scopes:** `user.info.basic`, `video.publish`, `video.list`
- **Redirect URI:** `https://<domain>/api/social/callback/tiktok`
- **Domain:** verify the Supabase Storage domain (`<ref>.supabase.co`) in the TikTok app for `PULL_FROM_URL`.
- **Visibility:** until TikTok **audits** the app, every post is private (`SELF_ONLY`). Keep `TIKTOK_PRIVACY_LEVEL=SELF_ONLY` until then.
- **Webhook (optional):** `https://<domain>/api/social-webhooks/tiktok`
- **Env:** `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_PRIVACY_LEVEL`

### YouTube

- **Project:** a Google Cloud project with **YouTube Data API v3** enabled, an OAuth consent screen and an **OAuth client (Web application)**.
- **Redirect URI:** `https://<domain>/api/social/callback/youtube`
- **Scopes:** `youtube.upload`, `youtube.readonly`, `youtube.force-ssl` (the last is needed for comment replies)
- **Visibility:** uploads from **unverified** projects are locked to private. Keep `YOUTUBE_PRIVACY_STATUS=private` until Google completes the API compliance audit.
- **Quota:** the default quota of 10,000 units/day allows about 6 uploads.
- **Env:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `YOUTUBE_PRIVACY_STATUS`

### X

- **App:** create a project and app at developer.x.com. Enable **OAuth 2.0**, type **Web App (confidential client)**.
- **Callback URI:** `https://<domain>/api/social/callback/x`
- **Scopes:** `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write`
- **Access tier:** write access and rate limits depend on your X API tier.
- **Webhooks (optional):** the Account Activity API needs `X_CONSUMER_SECRET`. Webhook URL: `https://<domain>/api/social-webhooks/x`
- **Env:** `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_CONSUMER_SECRET`

## Verifying an integration (do this once per platform)

1. Configure the env vars and redeploy.
2. **Social Accounts → Connect.** Complete the platform consent screen. You should land back on the page with "Account connected".
3. Create a content item with an image or video. Run the safety review, then request approval for a time 10 minutes from now. Approve it.
4. Wait for the cron cycle. The item should become **published**, and **History** should link to the post: private on TikTok and YouTube until your app is audited or verified.
5. If the post is **blocked**, the Publishing Queue shows the platform's error message. Fix it and re-request approval.
6. Record the result in `BUILD_REPORT.md`, changing the platform's status to COMPLETE.
