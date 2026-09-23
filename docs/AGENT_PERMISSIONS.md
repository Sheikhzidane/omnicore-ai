# Agent permissions

There are two separate agent systems, and they have deliberately different trust levels.

| | **Ops agents** (inherited Pantheon: god-agent, ruflo-runner, orchestrator, …) | **Character agents** (new engine) |
|---|---|---|
| Purpose | Maintain the legacy `/ops` tooling | Run an AI character's business (content, growth, CRM, finance) |
| Code | `scripts/*.mjs` | `lib/agents/` (executor arrives in Phase 5) |
| Queue | `todos` | `agent_tasks` |
| Policy | `scripts/lib-agent-permissions.mjs` | `lib/agents/permissions.ts` |
| Default | **Off** (`OPS_AGENTS_ENABLED` ≠ `true`) | **Off** (`AGENTS_ENABLED` ≠ `true`, and each agent row starts `disabled`) |
| File / git / SQL / shell | Heavily restricted (below) | **None, ever** |

## Things no agent may ever do

Neither system can autonomously modify:
- `.env*` files, secrets, API keys, social credentials, GitHub credentials
- authentication code, RLS policies, database migrations or schema
- `package.json` or lockfiles
- deployment configuration (`.github/`, `vercel.json`, `next.config.*`, `ecosystem.config.cjs`)
- billing configuration, security middleware (`proxy.ts`)
- the permission policies themselves

It also can't perform any prohibited automation: mass or unsolicited DMs, fake engagement, rate-limit evasion, impersonation, undisclosed sponsorship, or scraping private data (`lib/safety/prohibited.ts`).

## Ops agents: what was removed

| Capability (before) | Now |
|---|---|
| Ran whenever PM2 started them | Every agent script exits unless `OPS_AGENTS_ENABLED=true` is set **in the process environment** (shell or PM2). |
| `write_file` / `patch_file` anywhere in the repo | Allow-list only: `agent-workspace/` and `docs/agent-notes/`. The legacy ops UI (`components/*.tsx`, `app/(os)/ops/**`) is writable only when `OPS_AGENT_CODE_WRITES=true`. |
| Could read `.env.local` and then `fetch_url` it out | Secret files are unreadable (`checkReadPath`). |
| `run_ddl`, `run_sql`, `describe_table` (via SECURITY DEFINER `agent_exec_*`; `describe_table` was also SQL-injectable) | Denied. The functions no longer exist in the schema. The boot-time `ALTER TABLE` was removed. |
| `git add -A && git commit -m "${modelText}"` (shell injection) | Commits only allow-listed paths, and refuses if any protected path is dirty. Uses `execFileSync` (no shell). |
| `git push`, PR creation, `GITHUB_TOKEN` embedded in the remote URL | Removed. Commits stay local for human review. |
| Auto-release (tag + push) every 50 cycles | Removed, and `auto-release.mjs` is permanently disabled. |
| Self-modification of its own code (`god/self-modify.mjs`) | Targets are checked against the policy. `scripts/` is protected, so self-edits are impossible. |
| `GOD_AUTO_APPROVE`: agents approving their own tasks | Removed. Agent-created tasks and subtasks are always `proposed` and wait for a human in the Task Inbox. |
| Webhooks and anonymous API callers creating tasks for agents | Webhooks fail closed and create only `proposed` tasks. `/api/todos` requires an audited platform admin. |
| Reddit auto-posting (`promote-agent`) | Permanently disabled (anti-spam). |
| Affiliate links silently injected into published pages | Permanently disabled (undisclosed monetisation). |

Protected paths (`PROTECTED_PATTERNS`) override every allow-list and env flag. They include `scripts/` and `tests/`, so an agent can't edit the policy or the tests that enforce it. See `tests/agents/ops-permissions.test.mjs`.

## Character agents: capability model

Agents act only through **capabilities**. `authorizeAgentAction(agent, capability, agentsEnabled)` is the single decision point. The Phase 5 executor must call it before every tool call and log the outcome to `agent_run_events` and `audit_log`.

**Evaluation order.** The first matching rule wins:
1. The capability is in `FORBIDDEN_CAPABILITIES` → denied permanently, at every autonomy level.
2. The capability is unknown → denied (default deny).
3. The global kill switch `AGENTS_ENABLED` is off → denied.
4. The agent isn't `active` → denied.
5. The agent's role doesn't hold the capability → denied (least privilege).
6. A `suggest_only` agent is attempting a side effect → denied.
7. A side-effect capability (publish, schedule, send outreach) → allowed, but **requires human approval** unless autonomy is `autonomous_within_limits`. Even then, the publish gate (`lib/safety/approval.ts`) still requires approval for sponsored or flagged content and enforces platform limits.

**Roles** (`ROLE_CAPABILITIES`):

| Role | Capabilities |
|---|---|
| CEO | create internal tasks, read and summarise analytics, recommend strategy |
| Creative Director | review content, ideate, recommend strategy |
| Content | ideate, draft |
| Social | schedule and publish **approved** content, read analytics |
| Community | draft replies to comments on the character's own posts |
| Growth | read and summarise analytics, recommend strategy, create internal tasks |
| Sales | research brands, score fit, draft outreach, send **approved** outreach |
| Analytics | read and summarise analytics |
| Finance | read revenue, draft invoice reminders |

**Database backing:**
- Agents start `disabled`.
- Tasks start `proposed`.
- A check constraint stops a task that requires approval from reaching an executable state without `approved_at`.
- `claim_agent_tasks()` (service role only) claims tasks only for `active` agents.
- All writes are server-only.

## Privileged actions checklist

Every privileged agent action (control, approve, publish, send, connect credentials) must:
1. require an authenticated user (verified with the Auth server),
2. check the correct workspace, derived server-side and never taken from input,
3. authorise server-side (`requirePlatformAdminApi` / `requireWorkspaceApi` plus `authorizeAgentAction`),
4. write `audit_log` **before** acting, and refuse if the write fails.
