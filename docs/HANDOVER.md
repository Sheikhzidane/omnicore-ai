# Handover

Read this first if you are taking over Omnicore.

## What it is

Omnicore is a Next.js + Supabase application for running **fictional AI influencer characters** responsibly:

- **Characters** have an identity: profile, personality, visual rules, brand rules, content policy, assets and canon memory.
- **Content** moves from idea through draft, safety review and human approval to scheduled and published posts, on the platforms' official APIs.
- **15 agents** per character draft, analyse and propose. They have no tools, and anything with real-world effect needs a human decision.
- **Engagement**, **growth analytics** and **monetisation** (deals, affiliate links, products, revenue, expenses, ROI) run on real data only.

## Where to start reading

1. [ARCHITECTURE.md](ARCHITECTURE.md): modules, request flow, content lifecycle.
2. [SECURITY.md](SECURITY.md): auth layers, RLS, approvals, secrets, webhooks. Read this before changing any of them.
3. `supabase/migrations/README.md`: the schema, file by file.
4. `BUILD_REPORT.md`: what is complete, what needs credentials, and what still needs live verification.

## Invariants — do not break these

- Workspace isolation:
  - Reads go through the RLS client.
  - Server writes use the service role and **always** filter by `workspace_id`.
  - Composite `(id, workspace_id)` foreign keys back this up.
- No `anon` grants or policies on any table. No public Storage buckets.
- Every server action goes through `runAction` (tested). Every API route is public-and-verified or guarded (tested).
- Human approval before publishing, replying or outreach. The approval state machine is a database trigger; don't bypass it with raw updates.
- Agents have no tools, and `AgentStore` must never gain file, SQL, shell, git, env, credential or policy methods (tested).
- Social tokens are only ever stored encrypted, through the `private` schema RPCs. They are never logged or returned to the client.
- Webhooks verify signatures before parsing and fail closed.
- No fabricated metrics: missing data is shown as "—" and never estimated.
- Never connect CI or tests to a live Supabase project. Never auto-deploy.

## Day-to-day

| Task | How |
|---|---|
| Change the schema | Add a new migration (never edit an applied one), then run `npm run db:types` against a disposable DB, then `npm run test:db` |
| Add an agent task | Add it to `lib/agents/definitions.ts` (input/output schema, capabilities, `apply` through `AgentStore`); add tests in `tests/agents/executor.test.ts` |
| Add a platform | Implement `SocialProvider` in `lib/social/providers/`, register it in `index.ts`, add env vars to `integrations.ts`, `.env.example` and `docs/ENVIRONMENT.md`, and add tests |
| Add an AI provider | See `docs/AI_PROVIDERS.md` |
| Rotate `CRON_SECRET` | Update it in Vercel and redeploy |
| Rotate `CREDENTIALS_ENCRYPTION_KEY` | Every social account must be reconnected afterwards (there is no re-encryption job) |
| Emergency stop | `AGENTS_ENABLED=false` (agents); Settings → Publishing Policies (publishing) |

## Open items

`BUILD_REPORT.md` has the full list. The main ones are:
- Verify each social integration against the live platform.
- The video-generation flow in the UI.
- Automatic account-level analytics sync (CSV import exists today).
- Campaign management UI (the tables exist).
- Deciding whether to remove the legacy `/ops` area and Pantheon marketing pages.
