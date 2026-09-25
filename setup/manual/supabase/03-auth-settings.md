# Supabase 3 — Sign-in settings

**Time:** about 5 minutes.

1. Open **Authentication → URL Configuration**.
2. **Site URL:** your live address, e.g. `https://omnicore.yourdomain.com`. If you don't have one yet, use the `…vercel.app` address from the Vercel guides and come back to update it later.
3. **Redirect URLs:** click **Add URL** and add:
   - `https://YOUR-DOMAIN/auth/callback`
   - `http://localhost:3000/auth/callback` (only needed for local testing)
4. Open **Authentication → Users → Add user → Create new user**.
   - Enter **your** email and a strong password, and tick **Auto Confirm User**.
5. Open **Authentication → Providers → Email** (called **Sign In / Providers** in some versions).
   - Keep Email enabled.
   - Turn **Allow new users to sign up** **off**.
6. Remember that your email must also go into `AUTH_ALLOWED_EMAILS` in Vercel (Vercel guide 2).

✅ Done when your user appears under **Users** and sign-ups are off.
