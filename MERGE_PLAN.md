# MERGE_PLAN — omnicore-ai ⇐ creator-crm

**Goal:** turn `omnicore-ai` into an **AI Influencer Autonomous Operating System** by taking the useful architecture and features from `creator-crm`, translated into omnicore-ai's Supabase stack. `omnicore-ai` stays the only application and the only Git repository.

| | |
|---|---|
| Primary repo | `omnicore-ai` @ `8df4f95` (branch `claude/repository-setup-sq8u29`, same as `origin/main`) |
| Reference repo | `creator-crm` @ `2220646` (read-only clone at `/home/user/sheikhzidane/creator-crm`) |
| Audit date | 2026-09-23 |
| Status | **Phase 0 complete: audit and plan only. No application code changed.** |

---

## 0. Findings that change the plan

Read these first. Several of them contradict assumptions in the original brief.

1. **omnicore-ai has no authentication.** Nothing calls `supabase.auth`, there is no login, and there are no users. The existing RLS policies are `to anon using (true)`, which lets anyone holding the public anon key read, insert, update and **delete** `todos` and several other tables. So "keep existing authentication" is not possible: authentication has to be **built** (Stage 3) before any character, credential or CRM data exists.
2. **Privileged API routes are open.** `/api/todos` (POST/PATCH/DELETE) uses the **service-role** client and does no auth check. `/api/agents/control` runs `pm2 start/stop` with no auth. Tasks created through `/api/todos` or the fail-open webhook (`/api/webhooks/[source]`, which is open when `GITHUB_WEBHOOK_SECRET` is unset) get executed by agents that have `write_file`, `run_ddl` and `git_commit` tools. That is a remote **prompt-injection → code-execution** path.
3. **The self-modifying agents can write anywhere in the repo.** `safePath()` in `scripts/ruflo-runner.mjs` only blocks paths *outside* the project root. `.env.local`, `supabase/migrations/`, `middleware.ts` and any auth code we add are all writable. `agent_exec_ddl` (SECURITY DEFINER) lets them run arbitrary DDL. 140 of the last 141 commits were written by this "God Agent" (inherited from the Pantheon fork, last active 2026-05-04).
4. **The baseline is red.**
   - `npm run build` **fails**: a type error in `api/USAGE_EXAMPLE.ts`, an agent-generated example file.
   - `tsc --noEmit` reports **18 errors** (`api/USAGE_EXAMPLE.ts` ×14, `scripts/batch-dismiss-alert-detections.ts` ×3, `lib/metrics-integration-example.ts` ×1).
   - Lint is **not configured**: there is no ESLint config, so `next lint` drops into an interactive setup prompt. CI marks lint as non-blocking, which hid this.
   - Tests: `npm test` passes, 14/14 (the god-memory tests and the blocklist test).
   - `tsconfig.tsbuildinfo` is committed and gets dirtied by every typecheck.
5. **Next 14 is no longer safe to ship.** `npm audit` reports 1 critical advisory and many high ones against `next@14.2.18`. They include *Authorization Bypass in Middleware* (<14.2.25), which matters because auth will be gated in middleware, and critical image-optimizer/RSC advisories whose fixes exist only in **≥15.5.24 / 16.3.x**. The 14.x line (latest 14.2.35) will not receive them. **A Next 16 + React 19 upgrade is a prerequisite, not an optional extra.** It also lines us up with creator-crm, which is already on Next 16 / React 19.
6. **The live database has drifted from `supabase/migrations/`.** Code reads and writes `traces`, `god_status`, `agent_logs`, `memories`, `reddit_tokens`, `cost_log` and ~20 other tables that no migration creates (the agents created them at runtime through `agent_exec_ddl`). The migration version numbers also collide: `0005`, `0007`, `0009` and `0011` each appear twice, which breaks `supabase db push`. **Three table names in your brief (`agents`, `agent_tasks`, `agent_runs`) might already exist in the live DB** in an unknown shape. New migrations must fail loudly if they find them (§6.6).
7. **creator-crm is a *brand-side* CRM; your product is *creator-side*.** creator-crm helps *a brand recruit human creators*. Your owner *is* the creator (the AI characters) and needs to *win brand deals*. The pipeline, scoring, outreach and rate logic carry over well, **but the direction flips** (§5). Porting its screens one-for-one would build the wrong product.
8. **creator-crm's security fails open everywhere.**
   - No `APP_PASSWORD` → the app is public.
   - No `CRON_SECRET` → `/api/discover` is public, and the `x-vercel-cron` header bypass can be spoofed.
   - No `APIFY_WEBHOOK_SECRET` → the webhook is public.
   - The auth cookie stores the raw password.
   - `findEmail()` scrapes email addresses from bios and link-in-bio pages for cold outreach, which conflicts with the no-spam requirement.

   None of this infrastructure should be ported.

---

## 1. Repository inventory: omnicore-ai (primary)

**Stack:** Next 14.2.18 (App Router), React 18, Tailwind 3.4, TypeScript 5 strict, Supabase (`@supabase/ssr` 0.5, `supabase-js` 2.47), Anthropic SDK 0.88, Resend, Stripe, PM2 for long-running agents, Vercel for the UI.

```
omnicore-ai/
├─ app/
│  ├─ page.tsx                 Pantheon dashboard (DashboardShell, 5 tabs: overview/tasks/agents/revenue/code)
│  ├─ layout.tsx               root layout (+ pronoun-detector console hook, Umami/Plausible, AdSense meta)
│  ├─ api/  (48 route files)   todos, agents/{control,logs}, panic, cost, god-*, git/*, github/*, revenue/*,
│  │                           marketplace, newsletter, subscribe, checkout (Stripe), webhooks/[source], tts, og …
│  ├─ topics/ de/ es/ fr/      107 agent-generated SEO article pages (marketing for Pantheon)
│  └─ about, contact, privacy, subscribe, stream, share/[id], rpc-errors
├─ components/ (91 files)      dashboard widgets: TaskInbox, TaskKanban, TodosTable, AgentControlPanel, PanicButton,
│                              CommandPalette, CostTracker, LiveFeed, TraceTimeline, PixelDungeon, Jarvis*, …
├─ lib/
│  ├─ supabase/{client,server,admin}.ts   ✔ the Supabase architecture we keep
│  ├─ rate-limit.ts                       ✔ sliding-window limiter used by middleware
│  ├─ pixel-agents/                       game engine for the "agent office" visual
│  └─ ~30 agent-generated loggers/analysers (response-*, tone-marker, word-count, pronoun-detector, …)
├─ scripts/ (~110 files)       the agent runtime:
│  ├─ god-agent.mjs (2,670 LOC)    self-improving orchestrator (edits its own code, writes SEO pages, releases)
│  ├─ ruflo-runner.mjs (1,460)     specialist pool executor: Claude tool-use, cost caps, circuit breakers,
│  │                               curriculum/trust tiers, traces, stale-task reaper
│  ├─ orchestrator.mjs             keyword/Claude routing of todos → agent pools
│  ├─ lib-llm.mjs                  Claude → Ollama fallback; lib-notify.mjs (Discord/Slack/Telegram/Pushover)
│  ├─ revenue-agent, promote-agent (Reddit auto-post), god-poster, seo-*, inject-*, affiliate-injector
│  └─ god/*.mjs + tests            memory (Jaccard dedup), goal emergence, self-modify, market research
├─ supabase/migrations/        0001–0032 (with duplicate version numbers, see §0.6)
├─ types/todos.ts              Database type (strict `todos`, permissive everything else)
├─ middleware.ts               rate limiting on /api only
├─ ecosystem.config.cjs        9 PM2 processes
└─ .github/workflows/ci.yml    typecheck (blocking), lint (non-blocking), build
```

### Database (as defined in migrations)

- **Core:** `todos` (agent task queue: `status` proposed→pending→in_progress→completed/failed/blocked/vetoed; `priority`; `assigned_agent`; `parent_task_id`; `comments` jsonb; `task_category`).
- **Plus about 35 observability/analysis tables:** DLQ, task_history, throughput, SLO, alert rules, conversation memory, claim verification, pattern detection, `subscribers`, and others.
- **RLS:** enabled on the core tables, but with `anon` allow-all policies. A few tables are `service_role`-only (`subscribers`, conversation tables).
- **SECURITY DEFINER RPCs:** `agent_exec_sql` and `agent_exec_ddl` (arbitrary SQL, granted to `service_role`).

---

## 2. Repository inventory: creator-crm (reference)

**Stack:** Next 16.2.4, React 19.2.4, Tailwind 4, Drizzle ORM 0.45 + Neon serverless Postgres, Radix UI primitives, Anthropic SDK 0.93, Resend, Apify (optional), Vercel Cron. Shared-password auth in `proxy.ts`. It has no ESLint config and no tests.

```
creator-crm/  (~4,000 LOC of TS/TSX)
├─ app/
│  ├─ page.tsx                   dashboard: pending candidates, today's tasks, stuck leads, stage counts
│  ├─ candidates/                review queue (AI-scored discovered creators) → approve/reject/restore, bulk cleanup
│  ├─ creators/                  roster (search + platform/stage/tag filters), profile [id] w/ notes, tags, tasks,
│  │                             handle edit, Apify enrichment
│  ├─ pipeline/                  10-stage kanban + stage mover (auto-creates follow-up tasks)
│  ├─ outreach/                  sent/draft list, AI composer, mark replied/cold
│  ├─ campaigns/                 placeholder ("coming next"), so nothing to port
│  ├─ login/                     shared-password login
│  └─ api/ discover (cron: Apify hashtag scrape → score → filter → insert), apify/webhook, avatar proxy
├─ components/ sidebar, avatar, activity-icon, ui/{badge,button,card,input,table}
├─ lib/
│  ├─ db/schema.ts               creators, candidates, campaigns, outreach, activities, tasks, tags (text IDs, text dates)
│  ├─ ai-scoring.ts              Claude Haiku fit scorer (0–10, persona, red flags, angle) + heuristic fallback
│  ├─ outreach-prompt.ts         cached system prompt + template fallback
│  ├─ stages.ts / stage-automations.ts   pipeline definition + stage→auto-task rules
│  ├─ rate-estimator.ts          follower tier × persona → price band
│  ├─ candidate-quality.ts       junk/brand/storefront detection
│  ├─ apify-client.ts            IG hashtag + profile scrapers, email harvesting
│  └─ activity.ts, brand.ts, utils.ts
└─ scripts/ (18)                 one-off Neon maintenance/backfill scripts
```

---

## 3. Keep, move to legacy, or delete: omnicore-ai

**Rule for this migration:** nothing that works is deleted. Code is either kept as core, moved to a legacy `/ops` area (preserved and reachable, but out of the main nav), or deleted. Only dead code is deleted: files with no importers that break the build or typecheck. Any other deletion needs your approval (§12).

### 3.1 Keep as core (the foundation we build on)

| Area | Files | Notes |
|---|---|---|
| Supabase architecture | `lib/supabase/{client,server,admin}.ts` | Add `import 'server-only'` to `admin.ts`, and generate full DB types. |
| Claude integration | `@anthropic-ai/sdk`, `scripts/lib-llm.mjs` (fallback pattern), cost-cap logic in `ruflo-runner.mjs` | Consolidate into `lib/ai/` (§7.4). |
| Agent architecture | `orchestrator.mjs`, `ruflo-runner.mjs`, `god-agent.mjs`, `scripts/god/*` | Kept as the **Ops (dev-automation) subsystem**, disabled by default and fenced off from product data (§7.3). Its patterns (budgets, breakers, trust tiers, stale-task reaper, traces) are reused in the new character-agent executor. |
| Agent task execution | `todos` table, `TaskInbox` (propose → approve/veto), `TaskKanban`, `TodosTable`, `TaskTraceDrawer`, `AddTodoForm` | Stay on `/ops` for dev tasks. The *propose → approve* flow is the model for content and outreach approval. |
| Agent logs | `/api/agents/logs`, `traces`, `LiveFeed`, `BattleLog`, `TraceTimeline` | Stay on `/ops`. Character agents get `agent_runs` + `agent_run_events`. |
| Agent control | `AgentControlPanel`, `PanicButton` (`/api/panic`, token-gated), `AgentPoolStrip` | Kept. They gain auth, and the kill-switch model extends to characters. |
| Dashboard foundation | `DashboardShell`, `PanelShell`, `Collapsible`, `CommandPalette` (⌘K), `KeyboardShortcuts*`, `ErrorBoundary`, `Skeleton`, `LoadingSpinner`, `StatusBadge`, `PriorityBadge`, `ConnectionStatus`, `TimeWindowPicker`, `lib/use*` hooks | These become the OS shell's building blocks. |
| Security | RLS-everywhere habit, `lib/rate-limit.ts`, HMAC webhook verification, panic token | Harden: fail closed, tighten policies (§8). |
| Integrations | Resend, Stripe checkout, `scripts/lib-notify.mjs` | Resend → outreach sending, Stripe → future fan subscriptions, notify → approval alerts. |
| Tooling | `.github/workflows/ci.yml`, dependabot, `npm test` | Make every gate blocking. |
| Migrations | `0001`–`0032` | **Never edited.** New migrations use timestamp versions. |

### 3.2 Move to legacy `/ops` (preserved, out of the main nav)

- **Pantheon self-promotion:** `revenue-agent`, `promote-agent` (**Reddit auto-posting**, which must stay disabled because it conflicts with the anti-spam rules), `god-poster`, marketplace listings, `KitCTA`, `affiliate-injector`, `inject-*` scripts, `AmazonGeoSwap`, `DisplayAd`/AdSense, newsletter composer/subscribers.
- **SEO article pages:** `app/topics`, `app/{de,es,fr}/topics` (107 pages about Pantheon, not your product), plus `seo-content-loop`, `indexnow*`. **I recommend deleting these later (your decision).**
- **Gamification:** `PixelDungeon` + `lib/pixel-agents`, `AgentRPGStats`, `AgentXPBar`, `HouseCup`, trophies, factions, `VictoryFlash`, `BootSplash`, `ArcReactor`, Jarvis voice/briefings, TTS (`msedge-tts`, ElevenLabs).

### 3.3 Delete (dead agent-generated artefacts)

Delete in Stage 1 **only if** a file both breaks the build/typecheck **and** has zero importers:
`api/USAGE_EXAMPLE.ts`, `api/response.js`, `lib/metrics-integration-example.ts`, `scripts/batch-dismiss-alert-detections.ts`.

Other candidates, on a list for your approval (each has 0–1 importers, usually another logger):
- `main.ts`, `main.mjs`, `index.mjs`, `index.test.mjs`, `src/*`
- `logs/vocab-sample.txt`, `rpc_error_export_report.json`, `SCHEMA_QUERY_EVIDENCE.sql`, the `scripts/*.md` reports
- the response/tone/word-count/latency/early-stop/constraint loggers and `lib/pronoun-detector.ts` (which **monkey-patches `console.log` from the root layout**)
- the `types/*` classifiers
- `tsconfig.tsbuildinfo` → untrack and add to `.gitignore`

---

## 4. Migrate, adapt, or discard: creator-crm

`creator-crm` code is **ported by hand**, never copied wholesale. Each file is rewritten against Supabase (UUIDs, `timestamptz`, RLS-scoped clients) and the creator-side domain. Ported files carry an MIT attribution header, and `docs/third-party/creator-crm-LICENSE` keeps the original copyright notice.

### 4.1 Migrate (adapt)

| creator-crm | → omnicore-ai | Adaptation |
|---|---|---|
| `lib/stages.ts` | `lib/crm/stages.ts` | Creator-side deal stages (§5.2); keep the colour map and type guard. |
| `lib/stage-automations.ts` | `lib/crm/stage-automations.ts` | Sets `leads.next_action/next_action_at` and logs a `crm_activities` row instead of creating a task row. |
| `lib/ai-scoring.ts` | `lib/crm/fit-scoring.ts` | **Inverted:** scores *brand ↔ character* fit (niche alignment, audience overlap, conflicts with brand rules, competitor/exclusivity conflicts with active deals, budget tier). Keeps the heuristic fallback, the cached system prompt and JSON output, now validated with zod. Calls go through `lib/ai`. |
| `lib/outreach-prompt.ts` | `lib/crm/outreach-prompt.ts` | **Inverted:** the character's management pitches a brand. The pitch always states that the talent is an AI character. Template fallback kept. |
| `lib/rate-estimator.ts` | `lib/monetisation/rate-card.ts` | **Inverted:** what *our* character should charge, by platform × follower tier × engagement. Feeds the media kit and deal negotiation. |
| `lib/candidate-quality.ts` | `lib/crm/account-classifier.ts` | Reused as `classifyAccount(bio) → brand \| creator \| storefront \| unknown`. A brand signal is now *wanted* for prospects. |
| `lib/activity.ts` | `lib/crm/activity.ts` | Inserts into `crm_activities` (uuid, actor_type user/agent/system). |
| `lib/utils.ts` (`formatNumber`, `relativeDate`) | merged into `lib/utils.ts` | `cn` already exists. |
| `lib/apify-client.ts` | `lib/discovery/apify.ts` | Optional, **disabled by default**, reported as `disconnected` without `APIFY_TOKEN`. Retargeted to (a) benchmarking peer creators and (b) finding brands that already sponsor creators in the niche (from `#ad`/`@mentions`). **`findEmail()` is not ported.** |
| `components/ui/{badge,button,card,input,table}.tsx` | `components/ui/` | omnicore's `components.json` already points shadcn at `@/components/ui`, but the folder doesn't exist yet. This is a drop-in. Add Radix `dialog`, `dropdown-menu`, `label`, `select`, `slot`. |
| `components/sidebar.tsx` | `components/shell/sidebar.tsx` | New module nav (§9). Logout via Supabase. |
| `components/avatar.tsx`, `activity-icon.tsx` | `components/ui/avatar.tsx`, `components/crm/activity-icon.tsx` | Avatars come from Supabase Storage (signed URLs), not an IG CDN proxy. |
| `app/pipeline/*` (kanban + stage mover) | `app/(os)/crm/pipeline` | Server actions → Supabase with the user's session (RLS enforced). |
| `app/creators/page.tsx` (search, filters, tags) | `app/(os)/crm/brands` | Same filter/search UX over `brands`. |
| `app/creators/[id]/*` (profile, notes, tags, tasks) | `app/(os)/crm/brands/[id]`, `app/(os)/crm/pipeline/[leadId]` | Timeline from `crm_activities`. |
| `app/candidates/*` (review queue, approve/reject, cleanup) | `app/(os)/crm/prospects` | Review queue for AI-scored brand prospects. |
| `app/outreach/*` (list, composer, status) | `app/(os)/crm/outreach` | Adds approval, suppression list, daily cap and an unsubscribe line (§10). |
| `app/page.tsx` widgets (today, stuck leads, stage counts) | `app/(os)/dashboard` CRM widgets | Stuck-lead logic reused. |
| `scripts/seed-from-csv.ts` | `app/(os)/crm/brands/import` (CSV import) | Uses `csv-parse`, records `source='csv'`. |

### 4.2 Discard

| creator-crm | Why |
|---|---|
| `lib/db/*`, `drizzle.config.ts`, `db:*` scripts, `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`, `dotenv` | Supabase stays the only database layer. |
| `proxy.ts` password gate, `app/login/*` | Replaced by Supabase Auth. Shared-password cookies fail open. |
| `app/api/discover` (cron), `app/api/apify/webhook` | Creator-hashtag scraping is the wrong direction; the auth fails open. Rebuilt fail-closed if discovery is enabled. |
| `app/api/avatar/[kind]/[id]` | IG CDN hotlink proxy. Not needed. |
| `creators/fix-handles`, `enrich-actions`, `enrich-button` | IG scraping enrichment for recruited creators. Not our domain. |
| `lib/apify-client.ts#findEmail` | Email harvesting for cold outreach conflicts with the no-spam rules. |
| `scripts/*` (18 Neon maintenance scripts), `AGENTS.md`/`CLAUDE.md`, Geist fonts, `public/*.svg` | Specific to that repo or boilerplate. |

---

## 5. Domain translation: brand-side CRM → creator-side OS

### 5.1 Entity mapping

| creator-crm concept | AI Influencer OS concept |
|---|---|
| `creators` (people the brand recruits) | **`brands`** (companies our characters want deals with) + **`contacts`** (people at those brands) |
| `candidates` (auto-discovered creators awaiting review) | **`leads`** at stage `prospect`, with `fit_score` (brand prospects awaiting review) |
| `creators.stage` | **`leads.stage`** (one lead per character × brand) |
| `outreach` (brand → creator email) | **`outreach`** (character management → brand contact), approval-gated |
| `campaigns` (brand's creator campaign, unbuilt) | **`campaigns`** (a character's sponsorship, growth or launch campaign) |
| `tasks` (human follow-ups) | `leads.next_action/next_action_at` (human) **and** `agent_tasks` (agents) |
| `activities` | **`crm_activities`** |
| `tags` join table | `text[] tags` column + GIN index |
| `ratePaid/rateCeiling` | **`deals.value_cents`** + `revenue` rows |
| BRAND_NAME/BRAND_CONTEXT env | per-**`characters`** profile: niche, persona, brand rules (multi-character) |

### 5.2 Pipeline stages (creator side)

`prospect → researched → pitched → replied → negotiating → contracted → in_production → live → invoiced → paid → repeat_partner`, plus `lost`.

This maps almost 1:1 onto creator-crm's `Lead → Outreached → Replied → Negotiating → Briefed → Content In → Live → Paid → Past Hire / Cold`, so the kanban, the stuck-lead detector and stage automations port directly. When a lead reaches `negotiating`, a **`deals`** row is created. When a deal is paid, a **`revenue`** row is created.

---

## 6. Database migration strategy

### 6.1 Principles

1. **Supabase only.** Plain SQL migrations in `supabase/migrations/`, applied with `supabase db push` / the Supabase migration tooling. No ORM.
2. **Never edit applied migrations.** New files use **timestamp versions** (`20260923120000_<name>.sql`) so they can't collide with the duplicated `0005`/`0007`/`0009`/`0011` versions.
3. **Additive only.** New tables sit beside the legacy ones. No legacy table is renamed or dropped in this migration.
4. **Every table has:**
   - `id uuid primary key default gen_random_uuid()`
   - `workspace_id uuid not null` (the tenancy root, denormalised for cheap RLS)
   - `created_at` / `updated_at timestamptz not null default now()`, plus the existing `handle_updated_at()` trigger
   - FKs with explicit `on delete` behaviour
   - an index on **every FK** (Postgres doesn't create these automatically)
   - `check` constraints for enums (text + check, easier to evolve than PG enums)
   - RLS **enabled with no `anon` policies**
5. **Generated types.** `supabase gen types typescript` → `types/database.ts` replaces the permissive `types/todos.ts` shape. `Todo` types are kept for legacy.
6. **Local verification.** Postgres 16 is available in this environment. Each migration stage is applied to a throwaway local database, with a stub `auth` schema (`auth.users`, `auth.uid()`), before it's committed. A test also asserts that *every* `public` table created by a new migration enables RLS and has no `anon` policy.

### 6.2 Tenancy and access model

Two tables are added on top of your list. Without them there's nothing to hang RLS on.

- `workspaces` (id, name, owner_id → `auth.users`)
- `workspace_members` (workspace_id, user_id, role `owner|admin|editor|viewer`, PK on both columns)

The product starts as **single-owner** (one workspace, created on first sign-in), but every row carries `workspace_id`, so going multi-tenant later needs no schema change.

**RLS pattern:**
- The helper `private.is_workspace_member(ws uuid, min_role text)` is `SECURITY DEFINER`, `STABLE`, `set search_path = ''`, and lives in a **non-exposed** `private` schema.
- Policies use `(select private.is_workspace_member(workspace_id, 'viewer'))`. The `select` wrapper makes Postgres evaluate it once per statement rather than per row.
- Permissions by action:
  - `select`: viewer or above
  - `insert` / `update`: editor or above
  - `delete`: admin or above
  - `audit_log`: members may read; only the server writes; nobody may update or delete.
- Agents and background jobs write through the **service role, on the server only**, and every agent write also records `agent_run_id` for provenance.

### 6.3 Tables (requested list plus required support tables)

```
auth.users ─┬─< workspace_members >── workspaces ──< (everything below via workspace_id)
            │
characters ─┬─< character_assets
            ├─< social_accounts ── 1:1 ── private.social_credentials   (encrypted, never client-readable)
            ├─< content ──< content_queue >── social_accounts
            ├─< campaigns
            ├─< analytics  (→ social_accounts, → content)
            ├─< agents ──< agent_tasks ──< agent_runs ──< agent_run_events
            ├─< leads >── brands ──< contacts
            │     └─< outreach >── contacts
            ├─< deals >── brands, leads, campaigns
            └─< revenue >── deals, campaigns
crm_activities (→ lead/brand/contact/deal)     audit_log (append-only)
```

| Table | Key columns (beyond id / workspace_id / timestamps) |
|---|---|
| **characters** | `name`, `slug` (unique per workspace), `status` draft/active/paused/archived, `niche`, `bio`, `persona` jsonb (personality, voice, values, backstory), `visual_identity` jsonb, `brand_rules` jsonb, `content_policy` jsonb + `policy_version`, `ai_disclosure_mode` (always/bio_and_posts/bio_only; default **always**), `disclosure_text`, `min_audience_age` (default 13), `age_gated` bool, `approval_mode` (**human_required** default / auto_low_risk), `timezone`, `created_by` |
| **character_assets** | `character_id`, `kind` (reference_image/avatar/voice_sample/logo/style_guide/other), `storage_bucket`, `storage_path` (private bucket, signed URLs), `mime_type`, `bytes`, `provenance` (generated/owned/licensed), `rights_notes`, `depicts_real_person` bool (default false; **blocks use** unless consent evidence is attached), `is_primary` |
| **social_accounts** | `character_id`, `platform` (instagram/tiktok/youtube/x), `handle`, `external_account_id`, `status` (**disconnected** default/pending/connected/error/revoked), `scopes` text[], `connected_at`, `last_synced_at`, `last_error`, `capabilities` jsonb (what the adapter can *actually* do). Unique on (`platform`, `external_account_id`). **No token columns.** |
| *private.social_credentials* | `social_account_id` (unique), `ciphertext`, `iv`, `auth_tag`, `key_version`, `expires_at`, `refresh_expires_at`, `rotated_at`. Lives in the non-exposed `private` schema, with all privileges revoked from `anon`/`authenticated`. See §8.2. |
| **content** | `character_id`, `campaign_id?`, `deal_id?`, `kind` (idea/post/reel/short/story/thread/video), `title`, `brief`, `caption`, `script`, `media` jsonb (asset refs), `platform_variants` jsonb, `hashtags` text[], `status` (idea/draft/generated/in_review/approved/rejected/scheduled/published/failed/archived), `source` (human/agent), `agent_run_id?`, `safety_status` (unchecked/passed/flagged/blocked), `safety_report` jsonb, `is_sponsored`, `disclosure_applied` |
| **content_queue** | `content_id`, `social_account_id`, `scheduled_for`, `status` (pending_approval/approved/scheduled/publishing/published/failed/cancelled), `approval_required`, `approved_by`, `approved_at`, `rejected_reason`, `publish_attempts`, `external_post_id`, `published_url`, `published_at`, `last_error`, `idempotency_key` (unique). Partial index on (`status`, `scheduled_for`) where status is `approved` or `scheduled`. |
| **campaigns** | `character_id`, `brand_id?`, `deal_id?`, `name`, `type` (sponsorship/growth/launch/affiliate/other), `objective`, `brief`, `budget_cents`, `currency`, `status`, `start_date`, `end_date` |
| **analytics** | `character_id`, `social_account_id?`, `content_id?`, `metric` (followers/impressions/reach/views/likes/comments/shares/saves/watch_time_s/clicks/engagement_rate), `value` numeric, `granularity` (day/lifetime), `period_start`, `captured_at`, `source` (adapter name). Unique on (`social_account_id`, `content_id`, `metric`, `granularity`, `period_start`). Only real adapter data is stored, **never synthetic numbers**. |
| **agents** | `character_id`, `role` (ceo/creative_director/content/social/community/growth/sales/analytics/finance), `name`, `status` (**disabled** default/active/paused), `autonomy` (suggest_only/**approval_required** default/autonomous_within_limits), `model_tier`, `config` jsonb, `daily_budget_usd`, `max_actions_per_day`, `last_run_at`. Unique on (`character_id`, `role`). |
| **agent_tasks** | `character_id`, `agent_id`, `parent_task_id?`, `created_by_agent_id?`, `created_by_user?`, `type`, `title`, `input` jsonb, `priority`, `status` (proposed/pending/queued/running/awaiting_approval/completed/failed/cancelled), `requires_approval`, `approved_by`, `approved_at`, `scheduled_for`, `attempts`, `max_attempts`, `last_error`, `result` jsonb, `idempotency_key`. Partial index for claimable tasks. |
| **agent_runs** | `agent_task_id`, `agent_id`, `character_id`, `status` (running/succeeded/failed/cancelled/budget_exceeded/policy_blocked), `model`, `input_tokens`, `output_tokens`, `cost_usd` numeric(10,6), `started_at`, `finished_at`, `error`, `output` jsonb |
| *agent_run_events* | `agent_run_id`, `seq`, `type` (message/tool_call/tool_result/decision/policy_block/error), `payload` jsonb. This is the per-step agent log. |
| **brands** | `name`, `website`, `domain` (unique per workspace), `industry`, `niche_tags` text[], `country`, `size_band`, `description`, social handles, `source` (manual/csv/inbound/discovery), `status` (active/do_not_work_with/archived), `tags` text[], `notes` |
| **contacts** | `brand_id?`, `full_name`, `role_title`, `email`, `phone`, `linkedin_url`, `source`, `consent_basis` (published_business_contact/inbound/referral/existing_relationship), `do_not_contact`, `opted_out_at`, `notes` |
| **leads** | `character_id`, `brand_id`, `primary_contact_id?`, `stage` (§5.2), `stage_changed_at`, `fit_score` numeric(3,1), `fit_reasoning`, `fit_signals` jsonb (red flags, angle), `ai_scored`, `estimated_value_cents`, `next_action`, `next_action_at`, `owner_user_id`, `tags` text[], `lost_reason`. Unique on (`character_id`, `brand_id`). |
| **outreach** | `lead_id`, `contact_id`, `character_id`, `channel` (email; others disabled), `direction` (outbound/inbound), `subject`, `body`, `status` (draft/pending_approval/approved/sent/failed/replied/bounced/cold), `drafted_by` (human/agent), `agent_run_id?`, `approved_by`, `approved_at`, `sent_at`, `provider_message_id`, `thread_id`, `replied_at`, `failed_reason` |
| **deals** | `character_id`, `brand_id`, `lead_id?`, `campaign_id?`, `title`, `status` (negotiating/contracted/in_production/delivered/invoiced/paid/cancelled), `value_cents`, `currency`, `deliverables` jsonb, `usage_rights`, `exclusivity`, `exclusivity_until`, `disclosure_required` (default true), `start_date`, `due_date`, `contract_asset_path`, `invoiced_at`, `paid_at` |
| **revenue** | `character_id`, `source_type` (affiliate/sponsorship/subscription/tips/licensing/other), `deal_id?`, `campaign_id?`, `platform`, `description`, `amount_cents` bigint, `currency`, `occurred_on`, `status` (expected/pending/received/refunded), `external_ref`. Unique on (`workspace_id`, `source_type`, `external_ref`). |
| *crm_activities* | `lead_id?`, `brand_id?`, `contact_id?`, `deal_id?`, `type`, `title`, `body`, `metadata` jsonb, `actor_type` (user/agent/system), `actor_id` |
| *audit_log* | `actor_type`, `actor_id`, `action` (publish, send_outreach, connect_account, approve, policy_override, …), `entity_type`, `entity_id`, `details` jsonb. Append-only. |

*Italic* rows are support tables that I'm adding on top of the requested list, each for a stated reason. `experiments` and `strategies` (Growth) are deferred to Stage 11.

### 6.4 Supporting RPCs

- `claim_agent_tasks(p_limit int)` uses `FOR UPDATE SKIP LOCKED`, so parallel workers never double-run a task. `SECURITY DEFINER`, executable by `service_role` only.
- `claim_due_content_queue(p_limit int)` works the same way, for publishing.
- `ensure_workspace_for_user()` creates the owner workspace on first sign-in.

### 6.5 Legacy tables

The legacy tables (`todos`, DLQ, traces, and the rest) stay as they are through Stage 2. In Stage 3 their `anon` allow-all policies are replaced by `authenticated` member policies. The `/ops` dashboard's realtime subscription will then run under the signed-in session. `agent_exec_ddl` is **revoked** (the legacy ops agents lose arbitrary DDL; `agent_exec_sql` read access stays). *(Needs your OK, §12.)*

### 6.6 Live-DB preflight (required before the first push)

The live schema has drifted (§0.6), so before Stage 4 is applied to your real project:
1. Get a read-only schema snapshot (`supabase db dump --schema public`, or read-only inspection through the Supabase connector if you authorise it).
2. The first new migration starts with a guard: `if to_regclass('public.agents') is not null … raise exception`, and the same for every new table name. It aborts instead of letting `create table if not exists` silently skip a table that already exists in a different shape.
3. If a collision is found, we choose between renaming the legacy table and namespacing ours. We **don't** guess.

---

## 7. Agent orchestration layer

### 7.1 Two agent systems, deliberately separate

| | **Ops agents** (existing God/ruflo) | **Character agents** (new) |
|---|---|---|
| Purpose | Improve and maintain the codebase | Run one AI character's business |
| Tools | files, git, SQL/DDL, web | *Bounded domain tools only* (below). **Never** files, git, SQL or shell. |
| Queue | `todos` | `agent_tasks` |
| Runs | PM2 on your machine | cron-triggered API route (Vercel) **and/or** `scripts/character-worker.mts` (PM2), both using the same `lib/agents` |
| Default | **Disabled** (`OPS_AGENTS_ENABLED=false`) | **Disabled** per agent until activated |
| Data access | Never product tables' credentials | Its own character's rows only |

### 7.2 Character agent roles (`lib/agents/roles.ts`)

| Role | Responsibilities | Tools (examples) | Side effects |
|---|---|---|---|
| CEO | Weekly goals, delegation, KPI review | `create_task`, `read_kpis`, `read_calendar` | Creates tasks for other agents only |
| Creative Director | Keep the visual identity and brand rules consistent; review drafts | `read_character`, `review_content`, `propose_brand_rule_change` | Rule changes need approval |
| Content | Ideas, captions, scripts, platform variants | `create_content_draft`, `read_performance` | Drafts only |
| Social | Schedule *approved* content; publish through adapters | `schedule_content`, `publish_content` | Publishing gated by approval, policy, connection status and caps |
| Community | Suggested replies on the character's **own** posts | `draft_reply` | Always needs approval. **No unsolicited or mass DMs.** |
| Growth | Analyse performance, propose experiments | `read_analytics`, `propose_experiment` | Proposals only |
| Sales | Brand prospect research, fit scoring, outreach drafts, pipeline hygiene | `score_brand_fit`, `draft_outreach`, `update_lead_stage` | Outreach needs approval; daily cap |
| Analytics | Metric sync from connected adapters, summaries | `sync_metrics`, `summarize_metrics` | Reads only |
| Finance | Revenue ledger, invoice reminders, rate card | `read_revenue`, `draft_invoice_reminder` | Drafts only |

### 7.3 Executor design (`lib/agents/executor.ts`)

1. Claim a batch with `claim_agent_tasks`. Check global, workspace, character and agent kill switches (`AGENTS_ENABLED` env defaults to `false`).
2. Check the budget: per-agent daily USD, per-task cap and hourly circuit breaker (ported from `ruflo-runner`).
3. Call Claude with tool use restricted to **that role's registry**. Tool inputs and outputs are zod-validated. Every step is written to `agent_run_events`.
4. **External side effects are never executed straight from model output.**
   - Tools write *intents* (a content draft, a queue entry, an outreach draft).
   - The policy engine (§10) decides whether an intent is auto-approved under the agent's autonomy and the character's `approval_mode`, or goes to the Approval Queue.
5. Record `agent_runs` (tokens, cost, status). Log to `audit_log` for any publish, send or approval.
6. A stale-task reaper, retries with backoff, idempotency keys, and notifications through `lib-notify` for approvals and failures.

**Ops-agent fence (Stage 3):**
- `safePath()` gains a denylist: `.env*`, `supabase/`, `middleware.ts`/`proxy.ts`, `lib/auth/`, `lib/secrets/`, `lib/supabase/admin.ts`, `app/api/**/auth*`.
- Webhooks fail closed.
- `/api/todos` requires an authenticated admin.

### 7.4 Claude integration (`lib/ai/`)

- One server-only module: client, a **single model-routing table** (today model IDs are duplicated in at least 4 scripts), JSON-output helper with zod validation, prompt caching for system prompts, token and cost accounting into `agent_runs`.
- The Ollama fallback from `lib-llm.mjs` is kept as an optional provider.
- Model IDs will be updated to current Claude models in Stage 10 and checked against the Claude API reference at that point.

---

## 8. Security design

### 8.1 Authentication and authorisation

- Supabase Auth: email magic link and/or password, OAuth optional. `app/(auth)/login`, `app/auth/callback`, sign-out.
- `proxy.ts` (Next 16):
  - refreshes the Supabase session
  - redirects unauthenticated users away from `(os)` and `/ops`
  - keeps the existing API rate limiter
- Every server action and route handler calls `requireUser()` / `requireWorkspaceRole()`. **Middleware is not the only check** (defence in depth; see the middleware-bypass advisory in §0.5).
- Public by design: marketing pages, `/api/health`, and signed webhooks.

### 8.2 Secrets and social credentials

**Env only, never `NEXT_PUBLIC_`:**
- `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`
- `INSTAGRAM_APP_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`
- `CREDENTIALS_ENCRYPTION_KEY` (32-byte, base64), `CRON_SECRET`, `WEBHOOK_SECRETS`

**`import 'server-only'`** in `lib/supabase/admin.ts`, `lib/ai/*`, `lib/secrets/*`, `lib/social/*`. An accidental client import then fails the build.

**Social tokens:**
- OAuth code exchange happens on the server only, with `state` and PKCE in httpOnly cookies.
- Access and refresh tokens are encrypted with AES-256-GCM (a key version allows rotation) and stored in `private.social_credentials`.
- That schema isn't exposed through PostgREST, and all privileges are revoked from `anon`/`authenticated`, so only server code with the service role can read it, through `lib/secrets/credentials.ts`.
- The UI only ever sees `social_accounts.status`, `scopes` and timestamps.
- Supabase Vault is an acceptable alternative backend behind the same interface.

**CI guard** (`scripts/check-env-exposure.mjs`):
- fails if any `NEXT_PUBLIC_*` variable name contains `SECRET`, `SERVICE`, `TOKEN` or `PRIVATE`
- fails if the client bundle in `.next/static` contains a known server env var **name**

### 8.3 Hardening existing surfaces (Stage 3)

- Auth on:
  - `/api/todos`, `/api/agents/control`, `/api/git/revert`, `/api/newsletter/send`, `/api/god-chat`
  - every other mutating route
- Fail closed when unset: `GITHUB_WEBHOOK_SECRET`, `GENERIC_WEBHOOK_TOKEN`, `CRON_SECRET`.
- Remove `lib/pronoun-detector` from the root layout.
- Fix edge-runtime `fs` use in the middleware import chain (`lib/fallback-events.ts`). Next 16's Node-runtime `proxy.ts` also resolves this.

---

## 9. Social integration adapters

`lib/social/types.ts`:

```ts
interface SocialAdapter {
  platform: 'instagram' | 'tiktok' | 'youtube' | 'x'
  configStatus(): { configured: boolean; missing: string[] }        // which env vars are absent
  capabilities: { publish: boolean; analytics: boolean; comments: boolean; requiresAppReview: boolean }
  getAuthorizationUrl(state: string, codeChallenge: string): string
  exchangeCode(code: string, verifier: string): Promise<EncryptedCredentialInput>
  refresh(creds: Credential): Promise<EncryptedCredentialInput>
  publish(item: PublishRequest, creds: Credential): Promise<PublishResult>   // throws NotConnectedError
  fetchMetrics(req: MetricsRequest, creds: Credential): Promise<MetricPoint[]>
}
```

- **No fake integrations.** When client credentials are missing, an adapter reports `configured: false` and the account shows **Disconnected — missing `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`**. `publish()` throws `NotConnectedError`. Nothing ever returns a pretend success. Test doubles exist only in test files.
- The platform gates are real, and I'll re-check each one when implementing:
  - **Instagram:** content publishing needs a Business/Creator account and Meta app review.
  - **TikTok:** the Content Posting API requires an app audit; unaudited apps post privately.
  - **YouTube:** uploads from unverified API projects are restricted to private.
  - **X:** posting depends on the API access tier.

  The UI will show each platform's requirement, not hide it.
- Adapters honour platform rate-limit headers and back off. There is **no rate-limit evasion** (no rotating accounts, proxies or jitter tricks).

---

## 10. Content safety and anti-abuse

- **Per-character `content_policy`** (zod-validated jsonb):
  - disallowed topics
  - brand-safety word lists
  - claims that need a disclaimer (health, finance)
  - sponsored-content rules
  - `min_audience_age` / `age_gated`
  - platform-native AI-label flags
- **AI disclosure is on by default.**
  - Bio disclosure and a per-post label follow `ai_disclosure_mode`.
  - Sponsored posts (`is_sponsored` or `deal_id`) get `#ad`/paid-partnership disclosure **forced on**, and you can't turn it off.
- **Safety pipeline:** generate → deterministic rule checks → Claude policy classifier → `safety_status` + `safety_report` → Approval Queue.
  - `blocked` content can't be scheduled.
  - A `flagged` item needs an explicit human override, which is logged in `audit_log`.
- **Human approval mode is the default** for every character.
  - Auto-publish is possible only when **all** of these hold: `approval_mode = auto_low_risk`, safety `passed`, not sponsored, the account is `connected`, and the item is within daily caps.
- **Impersonation guard:**
  - Characters must be fictional.
  - `character_assets.depicts_real_person = true` blocks generation and publishing unless consent evidence is attached.
  - Prompts refuse to imitate real, identifiable people.
- **Age-gating:** adult-oriented characters require `age_gated = true` and are restricted to platforms and settings that support audience restriction. Sexual content involving minors, or characters who could be read as minors, is hard-blocked with no override.
- **Anti-spam (outreach and community):**
  - The first contact with any brand contact always needs human approval.
  - Per-workspace daily send cap (default 20) and per-contact cooldown.
  - `do_not_contact` / opt-out suppression is enforced at send time, and every email has an opt-out line.
  - Contacts must have a recorded `consent_basis`; no scraped emails.
  - **No DMs to people who haven't contacted the character first.** Community replies only on the character's own posts. No bulk follow/unfollow or engagement automation.

---

## 11. Dependency conflicts and resolution

| Package | omnicore-ai | creator-crm | Resolution |
|---|---|---|---|
| `next` | 14.2.18 (critical advisories) | 16.2.4 | **→ 16.3.x latest patched** (Stage 2) |
| `react`, `react-dom` | ^18 | 19.2.4 | **→ 19.2.x** |
| `@types/react(-dom)` | ^18 | ^19 | → ^19 |
| `eslint` / `eslint-config-next` | 8 / 14.2.18, **no config** | none | → ESLint 9 flat config + `eslint-config-next` 16 (Next 16 removed `next lint`) |
| `tailwindcss` | 3.4 (+ `postcss.config.mjs`, `autoprefixer`) | 4 (`@tailwindcss/postcss`, `@theme`) | **Keep 3.4.** 91 existing components use it. The ported creator-crm components use v3-compatible classes (checked: only `globals.css` uses v4 `@theme`, and it's rewritten). Tailwind 4 is optional later. |
| `@anthropic-ai/sdk` | ^0.88 (moderate advisory) | ^0.93 | → latest (≥0.128) |
| `@supabase/ssr` / `supabase-js` | 0.5.2 / 2.47 | — | → latest (the `getAll`/`setAll` cookie API is already in use) |
| `lucide-react` | ^1.8 | ^1.14 | → ^1.14 (same major) |
| `resend` | ^6.12 (advisory via `svix`) | ^6.12.2 | → latest 6.x |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `tsx`, `typescript` | same | same | no conflict |
| `@radix-ui/react-{dialog,dropdown-menu,label,select,slot}` | — | yes | **add** (React 19 compatible) |
| `csv-parse` | — | ^6.2 | **add** (brand/contact CSV import) |
| `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`, `dotenv` | — | yes | **don't add** |
| `zod`, `server-only` | — | — | **add**: input/LLM-output validation and client-import guard |
| `stripe`, `libsodium-wrappers`, `msedge-tts` | yes | — | keep (legacy/ops; Stripe reused for subscriptions later) |
| transitive `axios`, `form-data`, `nanoid`, `ws`, `uuid`, `postcss` | high advisories | — | fixed by upgrades and `npm audit fix` in Stage 2 |

**Next 16 migration work in omnicore-ai:**
- `middleware.ts` → `proxy.ts`
- async `params`/`searchParams`/`cookies()` everywhere (already partly done)
- `React.JSX` namespace and `useRef` argument type fixes (use the codemods: `@next/codemod upgrade`, `types-react-codemod`)
- Turbopack builds
- ESLint CLI

**Tests:** keep `node:test`, and add TypeScript tests through `node --import tsx --test`. No new framework.

---

## 12. Proposed final folder structure

```
omnicore-ai/
├─ app/
│  ├─ (marketing)/             public: landing, about, privacy, contact  [+ legacy topics until you decide]
│  ├─ (auth)/login/            Supabase Auth
│  ├─ auth/callback/route.ts
│  ├─ (os)/                    authenticated shell (sidebar layout)
│  │  ├─ dashboard/
│  │  ├─ characters/           page (library) · new/ · [id]/{page, personality, visual-identity, brand-rules, policies, assets}
│  │  ├─ content/              ideas/ · calendar/ · generated/ · approvals/
│  │  ├─ social/               page (overview) · [platform]/  (instagram · tiktok · youtube · x)
│  │  ├─ agents/               page (Control Centre) · tasks/ · logs/
│  │  ├─ growth/               analytics/ · performance/ · experiments/ · strategy/
│  │  ├─ crm/                  prospects/ · brands/[id] · outreach/ · pipeline/ · deals/
│  │  ├─ monetisation/         affiliate/ · sponsorships/ · subscriptions/ · other/
│  │  ├─ settings/             workspace, members, integrations status, policies defaults
│  │  └─ ops/                  ← existing Pantheon dashboard (moved from app/page.tsx), admin-only
│  └─ api/
│     ├─ (existing routes, now auth-guarded)
│     ├─ social/[platform]/{connect,callback}/route.ts
│     ├─ cron/{agents,publish,metrics}/route.ts     (CRON_SECRET, fail-closed)
│     └─ webhooks/[source]/route.ts                 (signature required)
├─ components/
│  ├─ ui/                      shadcn primitives (ported from creator-crm + Radix)
│  ├─ shell/                   sidebar, topbar, character switcher, command palette wiring
│  ├─ characters/ content/ social/ agents/ growth/ crm/ monetisation/
│  └─ (existing 91 components stay in place for /ops; relocate later, not now)
├─ lib/
│  ├─ supabase/                client · server · admin (server-only) · proxy session helper
│  ├─ auth/                    requireUser · requireWorkspaceRole
│  ├─ ai/                      claude client · models · json output · cost
│  ├─ agents/                  roles · registry · executor · policy engine · tools/
│  ├─ social/                  types · registry · instagram/ · tiktok/ · youtube/ · x/
│  ├─ secrets/                 credentials (AES-GCM, server-only)
│  ├─ content/                 safety · disclosure · scheduling
│  ├─ crm/                     stages · stage-automations · fit-scoring · outreach-prompt · account-classifier · activity
│  ├─ monetisation/            rate-card
│  ├─ discovery/               apify (optional, disabled by default)
│  ├─ email/                   resend wrapper (suppression + caps)
│  ├─ validation/              zod schemas
│  └─ (existing lib files unchanged)
├─ types/database.ts           generated Supabase types (+ legacy types/todos.ts)
├─ supabase/migrations/        0001–0032 (legacy) + 2026MMDDHHMMSS_*.sql (new)
├─ scripts/                    existing ops agents + character-worker.mts + check-env-exposure.mjs
├─ tests/                      unit (node:test + tsx) · migrations/RLS (local Postgres)
├─ docs/                       architecture.md · security.md · third-party/creator-crm-LICENSE
├─ proxy.ts                    (Next 16; replaces middleware.ts)
└─ MERGE_PLAN.md
```

---

## 13. Staged execution plan

**Gate after every stage:**
1. `npm run lint`
2. `npm run typecheck` (0 errors)
3. `npm test`
4. `npm run build` (with placeholder env)
5. For DB stages: apply all new migrations to a throwaway local Postgres and run the RLS tests

Failures are fixed before moving on, then one descriptive commit is pushed to `claude/repository-setup-sq8u29`.

| Stage | Scope | Done when |
|---|---|---|
| **0** | Audit + this plan + safety commit | ✅ this commit |
| **1: Green baseline** | Delete the 4 dead files that break the build; set up an ESLint flat config; add a `typecheck` script; untrack `tsconfig.tsbuildinfo`; make CI lint and typecheck blocking | All 4 gates green on the untouched feature set |
| **2: Framework upgrade** | Next 16.3.x, React 19.2, eslint-config-next 16, Anthropic SDK, `@supabase/ssr`, resend, `npm audit fix`; codemods; `middleware.ts` → `proxy.ts` | Gates green; `npm audit --omit=dev` has no critical/high findings in `next`; every existing route still builds |
| **3: Auth + hardening** | Supabase Auth, workspaces/members migration, `requireUser`, protect the routes in §8.3, fail-closed webhooks, ops-agent path denylist, legacy `anon` policies → `authenticated`, revoke `agent_exec_ddl`*, `server-only` guards, env-exposure check | Unauthenticated requests to protected routes get 401/redirect (tested) |
| **4: Core schema** | Live-DB preflight (§6.6); all §6.3 tables, RPCs, indexes, RLS; generated types | Migrations apply cleanly locally; RLS tests pass (member vs non-member vs anon) |
| **5: OS shell** | `components/ui` port, sidebar with every module, dashboard, honest "not built yet" pages, move the old dashboard to `/ops` | Every nav route renders behind auth |
| **6: Characters** | Library, create wizard, profile, personality, visual identity, brand rules, policies, assets (private Storage) | CRUD tested; real-person likeness guard enforced |
| **7: CRM** | Brands, contacts, prospects queue, fit scoring, pipeline kanban + automations, outreach (approval, caps, suppression, Resend), deals, CSV import | Ported logic unit-tested; outreach can't send without approval or to opted-out contacts |
| **8: Social accounts** | Adapter interface, 4 adapters, credential vault, OAuth connect/callback, disconnected-state UI | Missing env → `disconnected` with the names of the missing vars; no token ever reaches the client (tested) |
| **9: Content Studio** | Ideas, AI generation (text), safety pipeline, disclosure, Approval Queue, calendar, content_queue | Sponsored content can't be approved without disclosure; blocked content can't be scheduled |
| **10: Agents** | Roles, per-character agents, `agent_tasks` queue, executor, budgets, kill switches, cron route + worker, Control Centre/Tasks/Logs UI | Agents disabled by default; side effects only through approved intents; runs and costs logged |
| **11: Growth + Monetisation** | Analytics ingestion (only from connected adapters), performance, experiments/strategy tables, revenue ledger, rate card, affiliate/sponsorship/subscription views | No synthetic metrics; revenue reconciles against deals |
| **12: Verification + decommission** | Full regression, docs (`docs/architecture.md`, `docs/security.md`), a checklist that every creator-crm feature in §4.1 is ported | Then, and only then, delete the local creator-crm clone (the GitHub repo is untouched) |

\* Items marked with an asterisk need your confirmation first.

---

## 14. Decisions I need from you

1. **Single-owner or multi-tenant?** The schema supports both. The plan launches single-owner (one workspace per sign-up) unless you want invites and teams in v1.
2. **Legacy Pantheon features:** move to `/ops` as planned, or delete now? This covers the SEO topic pages, AdSense, Gumroad/marketplace/Kit CTAs, pixel office, Jarvis/TTS, and the Reddit auto-promote agent. My recommendation: move them to `/ops` during the migration, delete the SEO pages and the promote agent afterwards.
3. **Revoke `agent_exec_ddl`** from the legacy ops agents (recommended), or keep it?
4. **Live DB access for the §6.6 preflight:** do you want me to inspect your Supabase project read-only through the Supabase connector, or will you provide `supabase db dump --schema public` output?
5. **Apify discovery:** port it as an optional, disabled-by-default adapter (brand discovery and peer benchmarking only, no email harvesting), or leave it out entirely?

---

## Appendix A: Baseline evidence (2026-09-23, commit `8df4f95`)

```
npm ci                       → ok
npx tsc --noEmit             → 18 errors (api/USAGE_EXAMPLE.ts ×14, scripts/batch-dismiss-alert-detections.ts ×3,
                                          lib/metrics-integration-example.ts ×1)
npm test                     → 14/14 pass
npm run lint                 → not configured (interactive ESLint setup prompt)
npm run build                → FAILS: ./api/USAGE_EXAMPLE.ts:24:18 "Expected 4 arguments, but got 3"
                               (+ warning: Node 'fs' imported into Edge middleware via lib/fallback-events.ts)
npm audit --omit=dev         → 10 vulnerabilities (1 critical, 5 high, 4 moderate); next fix requires ≥16.3.x
```
