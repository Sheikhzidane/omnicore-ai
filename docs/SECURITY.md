# Security model

Status as of Phase 1 (2026-09-23). Read this before changing auth, RLS, API routes, agents or secrets handling.

## 1. What was inherited, and what changed

| Area | Inherited from Pantheon | Now |
|---|---|---|
| Authentication | **None.** No login and no users. | Supabase Auth: password + magic link, `/login`, `/auth/callback`, `/logout` (POST). |
| Database access | RLS policies `to anon using (true)`: anyone with the public key could read, write and delete tasks. | RLS by workspace membership; **no `anon` policy or grant on any table**. |
| Privileged APIs | `/api/todos` used the service role with no auth check. `/api/agents/control` ran `pm2` unauthenticated. | Proxy gate plus an in-handler check on **every** route. Privileged actions are audited and fail closed. |
| Webhooks | Open when the secret was unset. Shopify/Stripe were accepted unverified. | Fail closed. Timing-safe comparison. Unverified sources are disabled. |
| Agents | Could write any file, run DDL, and commit and push with `GITHUB_TOKEN` (stored in the git remote URL). | Kill switch, write allow-list, protected-path deny-list, no push/DDL/raw SQL. See [AGENT_PERMISSIONS.md](AGENT_PERMISSIONS.md). |
| Framework | Next 14.2.18: critical middleware auth-bypass and RCE-class advisories. | Next 16.3.6 / React 19.3. `npm audit --omit=dev`: 0 vulnerabilities. |
| Backups | Nightly workflow **committed DB dumps (subscriber emails) into git** and pushed. | Manual only, private 7-day artifact, never committed. |
| Secrets in browser | The panic button kept a server token in `localStorage`. | Removed. CI fails if a secret can reach the client bundle. |

## 2. Identity and sessions

- Identity always comes from `supabase.auth.getUser()`, which is validated by the Supabase Auth server. Cookies are never decoded locally and trusted.
- **A client-supplied `owner_id`, `workspace_id` or `user_id` is never trusted.** The workspace is derived from `workspace_members` for the verified user (`lib/auth/session.ts`, `lib/auth/api.ts`).
- **V1 single owner:**
  - `AUTH_ALLOWED_EMAILS` limits who can sign in.
  - Accounts are auto-created only for allow-listed emails. With no allow-list, only users that already exist in Supabase can sign in.
  - Recommended: also disable public sign-ups in the Supabase dashboard.
- Post-login redirects go through `safeNextPath()`, which accepts same-origin relative paths only (open-redirect safe).
- Refreshed auth cookies are sent with `@supabase/ssr`'s `no-store` headers, so a CDN cannot cache one user's session for another.

## 3. Authorisation layers

1. **`proxy.ts`** (Next 16, Node runtime) applies the route policy in `lib/auth/routes.ts`:
   - `public`: marketing pages, login, signed webhooks, newsletter signup `POST`
   - `user`: any signed-in, allow-listed user
   - `ops`: platform admins only
   - Any `/api` path that isn't listed defaults to `ops`.
2. **Layouts** re-verify on the server: `requireWorkspace()` for the application shell and `requirePlatformAdmin()` for `/ops`.
3. **Route handlers** re-verify inside the handler:
   - `requirePlatformAdminApi(req, action)` for mutations. It writes `audit_log` **before** acting, and refuses the action if the audit write fails.
   - `requirePlatformAdminReadApi` for reads.
   - `requireWorkspaceApi` for product APIs.
   - `tests/auth/api-authorization.test.ts` statically checks that every handler in `app/api/**` is either public or guarded.
4. **RLS** is the final boundary (§4).

Handlers authenticate **before** parsing request bodies, so anonymous callers learn nothing about the API's schema.

**Platform admin** (`/ops`) is separate from workspace ownership. It is granted only from the server-side `OPS_ADMIN_EMAILS` variable, after a verified sign-in, via the service-role-only `sync_platform_admin` RPC. Clients cannot grant it.

## 4. Database (Supabase RLS)

- Every `public` table has RLS enabled, and `anon` has **no privileges on any table**.
- Workspace tables use `private.is_workspace_member(workspace_id, min_role)`. It is a `SECURITY DEFINER` function in the non-exposed `private` schema and is evaluated once per statement.
- **Server-only writes:** `characters`, `content_policies`, `platform_publishing_policies`, `agents`, `agent_tasks`, `agent_runs`, `agent_run_events`, `audit_log` and the legacy `todos` are **read-only to clients**. Writes happen on the server after authorisation, using the service role and with an audit entry.
- Composite `(id, workspace_id)` foreign keys mean no row can reference another workspace's rows, **even when written by the service role**.
- `audit_log` is append-only. A trigger blocks `UPDATE` and `DELETE` for every role, including the service role.
- Safety rules are enforced as constraints, not just in the UI:
  - AI disclosure can't be disabled
  - sponsored-content disclosure can't be disabled
  - human approval is the default
  - age-restricted characters must target 18+
  - a real-person likeness requires consent evidence
  - agent tasks that require approval can't run unapproved
- The inherited arbitrary-SQL functions (`agent_exec_sql`, `agent_exec_ddl`) **do not exist** in the new schema.
- Verified by `tests/db/rls.test.mjs`, which covers the anon lockout, workspace isolation, ownership escalation, admin forgery, server-only writes, constraints, audit immutability and task claiming against a disposable Postgres.

## 5. Secrets

- **Server-only** (never `NEXT_PUBLIC_`): `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `META_APP_SECRET`, `TIKTOK_CLIENT_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET`, `X_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `IMAGE_GENERATION_API_KEY`, `VIDEO_GENERATION_API_KEY`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, and the webhook secrets. See `.env.local.example`.
- Modules that touch secrets import `server-only` (the admin client, request and server clients, audit, secrets). An accidental client import fails the build.
- **Integration status** (`lib/config/integrations.ts`) reports only whether each variable is present, never its value. Unset integrations show **NOT CONFIGURED**. Present credentials show "configured (unverified)", and social accounts stay **DISCONNECTED** until an OAuth connection exists.
- **Social OAuth tokens** (from Phase 2+) are encrypted with AES-256-GCM (`lib/secrets/credentials.ts`: random IV, auth tag, key version) using `CREDENTIALS_ENCRYPTION_KEY`. They will be stored in a table clients cannot read and decrypted only in server memory. The UI only ever sees connection status.
- **CI `npm run check:secrets`** fails the build if a secret-like variable is exposed via `NEXT_PUBLIC_*`, if client code reads a server secret, or if a secret value appears in `.next/static`.
- A scan of the working tree and 146 reachable commits found no committed credentials. The clone is shallow, so older history wasn't scanned. Rotate any keys that were ever shared with the original Pantheon deployment.

## 6. Content and platform safety

See `lib/safety/`, and read `/settings` in the app.

- **Never permitted** (not configurable): mass DMs, unsolicited DMs, follow/unfollow automation, fake engagement or engagement pods, rate-limit evasion or account rotation, deceptive impersonation, undisclosed sponsorships, and scraping private data.
- **Hard-blocked content:** sexual content involving minors or minor-looking characters, non-consensual intimate imagery, real-person likeness without consent, impersonation, incitement, hate speech, and promotion of self-harm.
- **Publish gate** (`decidePublish`): publishing needs a connected account, publishing enabled for the platform, an active character, a passed safety check, complete disclosures, and must stay within daily and interval limits. A human must approve by default, and always for sponsored or flagged content.

## 7. Known residual risks

- Rate limiting is in-memory per instance (`lib/rate-limit.ts`). For multi-region production, use Upstash or Vercel KV.
- Legacy `/ops` API routes still read local files and PM2 (desktop-only features). They are admin-only and audited, and are candidates for removal.
- The legacy Pantheon marketing pages (`/topics`, AdSense) remain public until the owner decides to remove them.
- `ops` agent scripts still use `execSync` for some fixed commands (`tsc`, `git status`). Only fixed strings are passed, and every model-influenced command uses `execFileSync` with argument arrays.
- Supabase dashboard settings (sign-ups disabled, email templates, redirect URLs) must be configured by the owner. They can't be enforced from code.
