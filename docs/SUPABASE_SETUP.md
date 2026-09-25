# Supabase setup

Omnicore stores its database, authentication and file storage in **one Supabase project dedicated to Omnicore**.

> **Never** point Omnicore at a project that belongs to another application. In particular, the *Restaurant Marketing Agency* project (ref `duabcewljijbavljjxiz`) is permanently off-limits. Create a new project instead.
>
> Nothing in this repository connects to a live database on its own: CI and the tests use a throwaway Postgres. You apply migrations yourself, once, with the commands below.

## 1. Create the project

1. Sign in at <https://supabase.com/dashboard> with the account that should own Omnicore.
2. Click **New project**. Name it `omnicore` and choose a region close to your audience.
3. Generate a strong database password and save it in a password manager.
4. Wait for the project to finish provisioning.
5. Note the **project ref**: the `xxxxxxxxxxxxxxxxxxxx` part of `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`.

## 2. Copy the keys

Go to **Project Settings → API**:

| Value | Put it in |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` **and** `SUPABASE_URL` |
| `anon` `public` key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` (**secret**: server only, never in the browser, never in chat) |

## 3. Apply the migrations

This needs the Supabase CLI (<https://supabase.com/docs/guides/cli>) installed on your own computer.

```bash
cd omnicore-ai
supabase login                                # opens a browser
supabase link --project-ref <YOUR-OMNICORE-REF>
# The CLI prints the project it linked. CHECK that it is the Omnicore project.
supabase db push --dry-run                    # lists the migrations it would apply
supabase db push                              # applies them
```

`supabase/migrations/` contains the migration chain. `supabase/migrations/README.md` describes what each file does. If a table already exists, every migration aborts instead of changing it, so an unexpected existing schema is never overwritten.

The migrations create:
- the tables, with RLS enabled on every one
- the private schema and its functions
- the four **private** Storage buckets: `character-assets`, `reference-images`, `generated-content` and `campaign-assets`
- their read policies

## 4. Authentication settings

Go to **Authentication → URL Configuration**:
- **Site URL:** your production URL, e.g. `https://omnicore.yourdomain.com`
- **Redirect URLs:** add `https://<your-domain>/auth/callback` and `http://localhost:3000/auth/callback`

Go to **Authentication → Providers → Email**: keep **Email** enabled. Omnicore uses both password sign-in and magic links.

There is no public sign-up. Omnicore only lets addresses listed in `AUTH_ALLOWED_EMAILS` sign in. For defence in depth, also:
1. Create your own user: **Authentication → Users → Add user**. Set a password, or send yourself an invite.
2. Then turn **Allow new users to sign up** off in **Authentication → Providers → Email**, or under **Sign In / Providers** depending on your dashboard version.

Your first sign-in creates your personal workspace automatically. A database trigger makes you its owner.

## 5. Storage check

In **Storage**, confirm all four buckets exist and are marked **Private**. Do not make them public. Omnicore serves files through short-lived signed links only.

## 6. Backups

Enable **Point-in-Time Recovery** or rely on daily backups (**Database → Backups**). The repository's `backup.yml` workflow runs only when triggered manually and never commits data.

## Local development without a hosted project

Install Docker and the Supabase CLI, then run:

```bash
supabase init        # creates supabase/config.toml locally; leave the migrations folder as is
supabase start       # local Postgres + Auth + Storage in Docker
supabase db reset    # applies supabase/migrations to the LOCAL database only
```

`supabase start` prints a local URL and keys. Put them in `.env.local`. `supabase db reset` only ever touches the local Docker database.

## Regenerating the TypeScript types

After changing a migration, run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:types
```

Point `TEST_DATABASE_URL` at a disposable database. `tests/db/schema-types.test.mjs` fails if `types/database.ts` and the migrations disagree.
