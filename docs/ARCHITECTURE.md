# Architecture

Omnicore is an **AI influencer operating system**. One owner, optionally with team members, runs fictional AI characters. Each character has an identity, content pipeline, social accounts, agents, engagement inbox and revenue. Humans stay in control: nothing is published, sent or pitched without approval.

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 16.3 (App Router, Turbopack, `proxy.ts`), React 19.3, TypeScript strict, Tailwind 3.4 |
| Data, auth, storage | **Supabase only**: Postgres with RLS, Supabase Auth, Supabase Storage (private buckets) |
| AI | Provider-neutral interfaces (`lib/ai`). Adapters: Anthropic SDK (text, moderation) and OpenAI HTTP (text, image, video, moderation, embeddings). |
| Scheduling | Vercel Cron → `/api/cron/*` (bearer `CRON_SECRET`), with Postgres `SKIP LOCKED` queues |
| Validation | zod 4 on every server action, route handler, agent input/output and webhook mapping |
| Tests | `node:test` + tsx. Database tests run against a disposable Postgres 16. |

## Request flow

```
browser ──► proxy.ts ── lib/auth/routes.ts policy (default-deny for /api)
             │  session validated with Supabase Auth; AUTH_ALLOWED_EMAILS enforced
             ▼
  app/(os)/layout.tsx  requireWorkspace()           pages read through the RLS-scoped client
  app/(os)/**/actions.ts  runAction(role, fn)       writes: service role + workspace_id + audit
  app/api/social/*        requireWorkspaceApi(admin) OAuth connect/callback
  app/api/cron/*          requireCron()             publishing, agents, metrics
  app/api/social-webhooks/*, api/webhooks/stripe    signature verified before parsing
             ▼
  Supabase: RLS by workspace membership; composite (id, workspace_id) FKs; triggers for
  approval state machine, publishing guard, version immutability, audit append-only
```

## Modules

| Module | Code | Tables |
|---|---|---|
| Characters | `lib/characters/*`, `app/(os)/characters` | `characters`, `character_profiles`, `character_visual_rules`, `character_brand_rules`, `character_memories`, `character_assets`, `content_policies` |
| Content | `lib/content/{service,safety,media}.ts`, `app/(os)/content` | `content_ideas`, `content_items`, `content_versions`, `content_assets`, `content_calendar`, `campaigns`, `campaign_content` |
| Approvals | `lib/approvals/*`, `components/approvals` | `agent_approvals` |
| Publishing | `lib/publishing/{attempt,worker}.ts`, `lib/scheduling/time.ts` | `publishing_jobs`, `publishing_results`, `publishing_policies` |
| Social | `lib/social/providers/*`, `lib/social/{oauth,tokens}.ts` | `social_accounts`, `social_credentials_metadata`, `private.social_credential_secrets`, `webhook_events` |
| Agents | `lib/agents/{definitions,executor,store,supabase-store,runner,permissions}.ts` | `agents`, `agent_tasks`, `agent_runs`, `agent_run_events` |
| Growth | `lib/analytics/{metrics,sync}.ts`, `app/(os)/growth` | `analytics_daily`, `content_metrics`, `audience_metrics` |
| Engagement | `app/(os)/engagement`, `lib/webhooks/social.ts` | `engagement_items`, `engagement_replies` |
| Monetisation | `lib/monetisation/finance.ts`, `lib/payments/stripe.ts`, `lib/email/resend.ts` | `brand_contacts`, `leads`, `brand_deals`, `affiliate_links`, `products`, `revenue`, `expenses`, `character_financials` (view) |
| Settings | `app/(os)/settings`, `lib/config/integrations.ts`, `lib/ai/registry.ts` | `workspaces`, `workspace_members`, `integration_connections`, `audit_log` |
| Storage | `lib/storage/{buckets,server}.ts` | buckets `character-assets`, `reference-images`, `generated-content`, `campaign-assets` |

## Content lifecycle

```
idea ─► content_item (draft) ─► versions (immutable; each edit = new version, resets safety)
      ─► safety review: rules + moderation → passed | flagged (human clears) | blocked (edit)
      ─► disclosure applied (AI label, #ad for sponsored) as a new version if missing
      ─► approval request (publish_content, pinned to version N) ─► human APPROVES
      ─► publishing_job queued (idempotency key; unique live job per content+account)
      ─► cron: claim (SKIP LOCKED) → re-check every gate → provider.publish()
      ─► success: published + result URL │ transient: backoff retry │ permanent: blocked + reason
```

## Agents

The system has 15 roles: CEO/Strategy, Character, Trend Research, Creative Director, Content Planner, Copywriter, Image Prompt, Video Script, Quality, Safety, Publishing, Community, Growth Analyst, Sales and Finance Analyst.

Each role defines task types in `lib/agents/definitions.ts`. Every task type has:
- an input schema
- an output schema (requested as structured JSON, then re-validated)
- the capabilities it needs
- a fixed `apply` handler

The executor (`lib/agents/executor.ts`) runs these steps in order:
1. Authorise every capability.
2. Validate the input.
3. Check the budget and the daily action limit.
4. Build the deterministic character identity prompt (canon memories only).
5. Call the provider.
6. Apply the output through `AgentStore`.
7. Record the run, events and cost.

Side effects are only ever `requestApproval(...)`.

## Folder structure

```
app/(os)/        dashboard, characters/[id]/*, content/*, social, agents/*, growth/*, engagement/*,
                 monetisation/*, settings/*, ops/ (legacy, platform admins)
app/api/         cron/*, social/{connect,callback}/[platform], social-webhooks/[platform],
                 webhooks/{stripe,[source]}, legacy ops APIs (guarded)
components/      shell/ (sidebar, tabs, filters), ui/ (forms, tables), approvals/, engagement/
lib/             ai, agents, analytics, approvals, auth, characters, config, content, data, email,
                 monetisation, payments, publishing, safety, scheduling, secrets, social, storage,
                 supabase, webhooks, actions.ts, audit.ts, cron.ts, nav.ts
supabase/        migrations/ (12 files) + README, tests/bootstrap.sql, legacy-migrations/ (archived)
tests/           agents, auth, content, db, safety, secrets, social, ui
docs/            ARCHITECTURE, SECURITY, ENVIRONMENT, DEPLOYMENT, SUPABASE_SETUP, VERCEL_SETUP,
                 SOCIAL_INTEGRATIONS, AI_PROVIDERS, AGENT_PERMISSIONS, HANDOVER, LOCAL_DEVELOPMENT
setup/manual/    step-by-step owner guides (supabase, vercel, social, ai-providers)
```

## Quality gates

The repository's quality checks are:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:db` (needs `TEST_DATABASE_URL`)
- `npm run build`
- `npm run check:secrets`
- `npm run check:committed-secrets`

CI runs all of them. The database job runs the migration and RLS suite in a `postgres:16` container. **CI never deploys.**

## Known debt

- The legacy `/ops` area and the Pantheon marketing pages (`/topics`, AdSense) remain. They are admin-only or public, and are candidates for removal.
- The legacy dashboard carries 63 lint warnings (React Compiler rules on inherited files); new code has none.
- Rate limiting is in-memory per instance.
- Account-level analytics (followers, reach) come from owner CSV imports. Only post-level metrics are pulled from platform APIs automatically.
