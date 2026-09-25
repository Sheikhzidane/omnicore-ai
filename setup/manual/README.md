# Manual setup guides

Plain-language, click-by-click guides for the setup steps that only the account owner can do: creating accounts, copying keys and approving apps. Work through them in this order:

1. [supabase/01-create-project.md](supabase/01-create-project.md)
2. [supabase/02-apply-migrations.md](supabase/02-apply-migrations.md)
3. [supabase/03-auth-settings.md](supabase/03-auth-settings.md)
4. [vercel/01-create-project.md](vercel/01-create-project.md)
5. [vercel/02-environment-variables.md](vercel/02-environment-variables.md)
6. [vercel/03-cron-and-domain.md](vercel/03-cron-and-domain.md)
7. [ai-providers/anthropic.md](ai-providers/anthropic.md) and/or [ai-providers/openai.md](ai-providers/openai.md)
8. Social platforms you use:
   - [social/instagram.md](social/instagram.md)
   - [social/tiktok.md](social/tiktok.md)
   - [social/youtube.md](social/youtube.md)
   - [social/x.md](social/x.md)

Golden rules:
- **Never paste a secret key into a chat, an email or a document.** Put keys only into Vercel's Environment Variables, or into your own local `.env.local`.
- **Use a brand-new Supabase project for Omnicore.** Never use the Restaurant Marketing Agency project, or any other existing project.
- If a step shows something different from what the guide describes, stop. Take a screenshot with no keys visible and ask for help.
