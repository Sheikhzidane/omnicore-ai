# Instagram

**Status:** implemented, but not yet tested against the live Instagram service. Do a private test post first.

**You will set:** META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN

1. Make sure the Instagram account is a **Professional** account: in the Instagram app, go to Settings → Account type and tools → Switch to professional account.
2. Go to <https://developers.facebook.com/apps> → **Create app**. Choose **Other → Business**, then give it a name such as "Omnicore Publishing".
3. In the app dashboard, add the product **Instagram**. Choose **API setup with Instagram login**.
4. Copy the **Instagram app ID** into Vercel as `META_APP_ID`, and the **Instagram app secret** as `META_APP_SECRET` (secret).
5. Under **Business login settings → OAuth redirect URIs**, add `https://YOUR-DOMAIN/api/social/callback/instagram`.
6. Under **Webhooks**, set the callback URL to `https://YOUR-DOMAIN/api/social-webhooks/instagram`. Choose any long random verify token, and put the same value in Vercel as `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to **comments** and **mentions**.
7. Under **App roles → Roles**, add the Instagram account as an **Instagram Tester**, then accept the invite in Instagram (Settings → Website permissions → Apps and websites). Until App Review is approved, only tester accounts can connect.
8. Redeploy in Vercel, then in Omnicore go to **Social Accounts → Instagram → Connect**.
9. For other people's accounts, or going public: submit **App Review** for `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments` and `instagram_business_manage_insights`.

**Good to know:** Instagram allows up to 100 API posts per day. Images and videos must be publicly fetchable, which Omnicore handles with temporary links.

✅ Done when Social Accounts shows the account as **connected**, and a scheduled test post appears in **Content → History** as published.

More detail: docs/SOCIAL_INTEGRATIONS.md
