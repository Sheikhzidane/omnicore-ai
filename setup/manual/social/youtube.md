# YouTube

**Status:** implemented, but not yet tested against the live YouTube service. Do a private test post first.

**You will set:** GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, YOUTUBE_PRIVACY_STATUS

1. Go to <https://console.cloud.google.com> → create a project, e.g. "omnicore".
2. Open **APIs & Services → Library**, search for **YouTube Data API v3** and click **Enable**.
3. Open **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name and your email, and add your Google account as a **Test user**.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID** and choose **Web application**.
5. Under **Authorised redirect URIs**, add `https://YOUR-DOMAIN/api/social/callback/youtube`.
6. Copy the **Client ID** into Vercel as `GOOGLE_OAUTH_CLIENT_ID`, and the **Client secret** as `GOOGLE_OAUTH_CLIENT_SECRET` (secret). Set `YOUTUBE_PRIVACY_STATUS` to `private`.
7. Redeploy, then go to **Social Accounts → YouTube → Connect**, and sign in with the Google account that owns the channel.
8. Videos from unverified projects are always private. To publish publicly, complete Google's **YouTube API compliance audit**, then set `YOUTUBE_PRIVACY_STATUS=public`.

**Good to know:** The default quota allows about 6 uploads per day. Every upload is declared as containing synthetic (AI) media.

✅ Done when Social Accounts shows the account as **connected**, and a scheduled test post appears in **Content → History** as published.

More detail: docs/SOCIAL_INTEGRATIONS.md
