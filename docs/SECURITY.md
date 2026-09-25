# Security model

Status as of the full product build (2026-09-25). Read this before changing auth, RLS, API routes, agents, approvals, webhooks or secrets handling.

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
4. **Server actions** (`app/(os)/**/actions.ts`) all go through `runAction(minRole, …)` (`lib/actions.ts`):
   - it verifies the session and derives the workspace from membership, never from form input
   - it checks the role
   - it writes with the service role, **every query scoped by `workspace_id`**
   - `tests/ui/nav.test.ts` fails if an exported action bypasses `runAction`
5. **RLS** is the final boundary (§4).

Handlers authenticate **before** parsing request bodies, so anonymous callers learn nothing about the API's schema.

**Platform admin** (`/ops`) is separate from workspace ownership. It is granted only from the server-side `OPS_ADMIN_EMAILS` variable, after a verified sign-in, via the service-role-only `sync_platform_admin` RPC. Clients cannot grant it.

## 4. Database (Supabase RLS)

- Every `public` table has RLS enabled, and `anon` has **no privileges on any table**.
- Workspace tables use `private.is_workspace_member(workspace_id, min_role)`. It is a `SECURITY DEFINER` function in the non-exposed `private` schema and is evaluated once per statement.
- **Server-only writes:** every product table (characters, identity, content, approvals, publishing, social, analytics, engagement, monetisation, agents, audit) is **read-only to clients** (`private.apply_workspace_rls`). Writes happen on the server after authorisation, using the service role; privileged ones write an audit entry first and refuse to proceed if that fails.
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

- **Server-only** (never `NEXT_PUBLIC_`): `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `META_APP_SECRET`, `TIKTOK_CLIENT_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET`, `X_CLIENT_SECRET`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, and the webhook secrets. See `.env.example` and docs/ENVIRONMENT.md.
- Modules that touch secrets import `server-only` (the admin client, request and server clients, audit, secrets). An accidental client import fails the build.
- **Integration status** (`lib/config/integrations.ts`) reports only whether each variable is present, never its value. Unset integrations show **NOT CONFIGURED**. Present credentials show "configured (unverified)", and social accounts stay **DISCONNECTED** until an OAuth connection exists.
- **Social OAuth tokens** are encrypted in the app with AES-256-GCM (`lib/secrets/credentials.ts`: random IV, auth tag, key version) using `CREDENTIALS_ENCRYPTION_KEY`.
  - The ciphertext lives in `private.social_credential_secrets`: a non-exposed schema, reachable only through the service-role-only RPCs `store/read/delete_social_credential`.
  - Plaintext exists only in server memory for the duration of a call.
  - Public tables hold only metadata (scopes, expiry, status).
  - Tokens never appear in error messages: provider errors strip query strings.
- **OAuth state** is sealed with the same key into an httpOnly, path-scoped, 10-minute cookie. The callback checks state, platform, the signed-in user and expiry. X and YouTube use PKCE.
- **`npm run check:committed-secrets`** (CI) fails if a tracked file contains an API key, private key, service-role JWT or real Supabase project URL, or if any `.env` file other than `.env.example` is tracked.
- **CI `npm run check:secrets`** fails the build if a secret-like variable is exposed via `NEXT_PUBLIC_*`, if client code reads a server secret, or if a secret value appears in `.next/static`.
- A scan of the working tree and 146 reachable commits found no committed credentials. The clone is shallow, so older history wasn't scanned. Rotate any keys that were ever shared with the original Pantheon deployment.

## 6. Approvals, agents and webhooks

- **Approvals** (`agent_approvals`): a database trigger enforces the state machine
  - `DRAFT → AWAITING_APPROVAL → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED`
  - A decision requires `decided_by`, so a human decides. Agents have no user identity and cannot approve anything.
  - The payload cannot change after submission.
  - High-risk actions, and credential, policy or financial changes, need an admin or the owner (`lib/approvals/rules.ts`).
  - Approved actions run through **fixed executors** that re-validate the payload.
- **Publishing:**
  - A job can only be `queued` with an `APPROVED` approval (trigger), and the content release gate requires safety `passed` plus disclosure plus an approval id.
  - At publish time, the worker re-checks the approved **version**, safety, disclosure, account, policy and rate limits.
  - A unique index forbids two live jobs for the same content and account, and only one success can be recorded per job.
- **Agents** have **no tools**. They return JSON that is validated against a schema, and a fixed handler applies it through `AgentStore`. `AgentStore` has no file, SQL, shell, git, env, credential or policy operation (`tests/agents/executor.test.ts`).
  - Side effects (publish, reply, outreach) can only become approval requests.
  - Each run is checked for capabilities, the global kill switch (`AGENTS_ENABLED`), the daily budget and the daily action limit, all **before** the model is called.
  - Tasks delegated by the CEO agent wait as `proposed` until a human queues them.
  - Agent-proposed memories are excluded from prompts until a human confirms them.
- **Webhooks:**
  - The signature is verified **before parsing**, and verification fails closed without a secret:
    - Meta: `X-Hub-Signature-256`
    - TikTok: timestamped HMAC with a 5-minute window
    - X: CRC and `x-twitter-webhooks-signature`
    - Stripe: `t=,v1=` with a 5-minute tolerance
  - Events are stored once (unique `provider + event_id`), so a replay is a no-op.
- **Cron** endpoints require `Authorization: Bearer $CRON_SECRET` (timing-safe) and return 503 when it is unset.

## 7. Content and platform safety

See `lib/safety/`, and read `/settings` in the app.

- **Never permitted** (not configurable): mass DMs, unsolicited DMs, follow/unfollow automation, fake engagement or engagement pods, rate-limit evasion or account rotation, deceptive impersonation, undisclosed sponsorships, and scraping private data.
- **Hard-blocked content:** sexual content involving minors or minor-looking characters, non-consensual intimate imagery, real-person likeness without consent, impersonation, incitement, hate speech, and promotion of self-harm.
- **Safety review** (`lib/content/safety.ts`) combines rules and the moderation provider:
  - Content claiming the AI character is human is **blocked**.
  - So are blocked topics, content over the rating ceiling, and hard moderation categories.
  - Review terms, health/finance/legal claims without a disclaimer, and **any content when no moderation provider is configured** are **flagged**. A human must clear a flag with a written reason (audited). Blocked content can only be fixed by editing it.
- **Outreach** goes to one contact at a time, and only after approval:
  - Each contact needs a recorded lawful basis.
  - Do-not-contact contacts are refused.
  - Every email states that the character is an AI and offers an opt-out.
  - Without an email provider, the approved text is handed back for manual sending instead of being "sent".
- **Publish gate** (`decidePublish`): publishing needs a connected account, publishing enabled for the platform, an active character, a passed safety check, complete disclosures, and must stay within daily and interval limits. A human must approve by default, and always for sponsored or flagged content.

## 8. Known residual risks

- Rate limiting is in-memory per instance (`lib/rate-limit.ts`). For multi-region production, use Upstash or Vercel KV.
- Legacy `/ops` API routes still read local files and PM2 (desktop-only features). They are admin-only and audited, and are candidates for removal.
- The legacy Pantheon marketing pages (`/topics`, AdSense) remain public until the owner decides to remove them.
- `ops` agent scripts still use `execSync` for some fixed commands (`tsc`, `git status`). Only fixed strings are passed, and every model-influenced command uses `execFileSync` with argument arrays.
- Supabase dashboard settings (sign-ups disabled, email templates, redirect URLs) must be configured by the owner. They can't be enforced from code.
- The social integrations have not yet been exercised against the live platforms (docs/SOCIAL_INTEGRATIONS.md).
- Rotating `CREDENTIALS_ENCRYPTION_KEY` makes stored tokens unreadable, so every account must be reconnected. There is no re-encryption job yet.
- A reply or outreach approval executes once. If the platform or email call fails, the approval is FAILED and needs a fresh decision; nothing is retried silently.
