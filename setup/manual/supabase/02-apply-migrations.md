# Supabase 2 — Create the database tables

**You need:** a computer with the repository downloaded, and the Supabase CLI installed (<https://supabase.com/docs/guides/cli/getting-started>). **Time:** about 10 minutes.

1. Open a terminal in the `omnicore-ai` folder.
2. Run `supabase login`. A browser window opens; approve it.
3. Run `supabase link --project-ref YOUR_PROJECT_REF`, replacing YOUR_PROJECT_REF with the 20 letters from guide 1.
   - When asked for the database password, paste the one you saved.
   - **Read the output.** It must name your **omnicore** project. If it names anything else, stop.
4. Run `supabase db push --dry-run`. It lists 12 migration files and changes nothing.
5. Run `supabase db push` and type `y` to confirm.
6. In the dashboard, open **Table Editor**. You should see tables such as `characters`, `content_items` and `agent_approvals`.
7. Open **Storage**. You should see four buckets, each marked **Private**: `character-assets`, `reference-images`, `generated-content` and `campaign-assets`.

✅ Done when the tables and the four private buckets exist.

If `db push` stops with "Preflight: … already exists", the project is not empty. Stop and ask for help, and do not delete anything.
