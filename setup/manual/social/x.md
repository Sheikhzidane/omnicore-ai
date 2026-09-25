# X

**Status:** implemented, but not yet tested against the live X service. Do a private test post first.

**You will set:** X_CLIENT_ID, X_CLIENT_SECRET, X_CONSUMER_SECRET

1. Go to <https://developer.x.com> → sign up for an API plan that includes **write access**.
2. Create a **Project** and an **App**. Under **User authentication settings**, click **Set up**.
3. Choose app permissions **Read and write**, and type of app **Web App, Automated App or Bot** (a confidential client).
4. Set the callback URI to `https://YOUR-DOMAIN/api/social/callback/x`, and the website URL to your domain.
5. Copy the **OAuth 2.0 Client ID** into Vercel as `X_CLIENT_ID`, and the **Client Secret** as `X_CLIENT_SECRET` (secret).
6. Optional, for mentions in the Engagement inbox: copy the **API Key Secret** (consumer secret) as `X_CONSUMER_SECRET`, and register `https://YOUR-DOMAIN/api/social-webhooks/x` with the Account Activity API. This needs an eligible API tier.
7. Redeploy, then go to **Social Accounts → X → Connect**.

**Good to know:** Omnicore posts text and single images to X. Video posts are not supported yet.

✅ Done when Social Accounts shows the account as **connected**, and a scheduled test post appears in **Content → History** as published.

More detail: docs/SOCIAL_INTEGRATIONS.md
