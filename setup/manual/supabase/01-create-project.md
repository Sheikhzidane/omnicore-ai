# Supabase 1 — Create the Omnicore project

**You need:** the Supabase account that should own Omnicore. **Time:** about 5 minutes.

1. Go to <https://supabase.com/dashboard> and sign in.
2. Click **New project**.
3. **Organization:** choose yours. **Name:** `omnicore`. **Region:** the one closest to your audience.
4. **Database password:** click **Generate a password**. Save it in your password manager.
5. Click **Create new project** and wait until the dashboard stops showing "Setting up project".
6. In the left menu, open **Project Settings → API**. Keep this page open; you will copy three values from it later.
   - **Project URL** (looks like `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`)
   - **anon public** key
   - **service_role** key. This one is **secret**: never share it.
7. Write down the **project ref**: the 20 letters in the Project URL. You need it in the next guide.

✅ Done when the project dashboard shows your new project named `omnicore`.

⚠️ If the project list shows *Restaurant Marketing Agency*, do **not** open or change it. Omnicore must use its own project.
