# TikTok

**Status:** implemented, but not yet tested against the live TikTok service. Do a private test post first.

**You will set:** TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_PRIVACY_LEVEL

1. Go to <https://developers.tiktok.com> → **Manage apps → Connect an app**.
2. Add the products **Login Kit** and **Content Posting API**. In Content Posting API, enable **Direct Post**.
3. Add the scopes `user.info.basic`, `video.publish` and `video.list`.
4. Under **Login Kit → Redirect URI**, add `https://YOUR-DOMAIN/api/social/callback/tiktok`.
5. Under **URL properties / Verify domain**, verify your Supabase storage domain (`YOUR_PROJECT_REF.supabase.co`), so TikTok can pull the videos.
6. Copy the **Client key** into Vercel as `TIKTOK_CLIENT_KEY`, and the **Client secret** as `TIKTOK_CLIENT_SECRET` (secret). Set `TIKTOK_PRIVACY_LEVEL` to `SELF_ONLY`.
7. Submit the app for review so it can be used. Until TikTok **audits** the Content Posting API use, every post is private (only you can see it).
8. Redeploy, then go to **Social Accounts → TikTok → Connect**.
9. After TikTok approves the audit, change `TIKTOK_PRIVACY_LEVEL` to `PUBLIC_TO_EVERYONE` and redeploy.

**Good to know:** Every TikTok post is labelled as AI-generated content automatically.

✅ Done when Social Accounts shows the account as **connected**, and a scheduled test post appears in **Content → History** as published.

More detail: docs/SOCIAL_INTEGRATIONS.md
