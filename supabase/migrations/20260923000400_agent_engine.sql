-- ============================================================================
-- Character agent engine: agents, agent_tasks, agent_runs, agent_run_events.
--
-- Audit note (Phase 1): `agents`, `agent_tasks` and `agent_runs` were
-- referenced only in agent-generated SEO article code samples
-- (app/topics/**); no inherited migration defines them and this fork has no
-- live database. They are defined here for the first time, safely.
--
-- These are NOT the legacy self-modifying ops agents (todos/traces). Character
-- agents have no file, git, SQL or shell access — see docs/AGENT_PERMISSIONS.md.
--
-- Access: members read; ALL writes are server-only (service role) after
-- server-side authorisation, with audit logging. Agents start disabled.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.agents','public.agent_tasks','public.agent_runs','public.agent_run_events'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists (possibly created at runtime by the inherited agents). See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

create table public.agents (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  role                text not null check (role in ('ceo','creative_director','content','social','community','growth','sales','analytics','finance')),
  name                text not null check (length(trim(name)) between 1 and 120),
  status              text not null default 'disabled' check (status in ('disabled','active','paused')),
  autonomy            text not null default 'approval_required'
                        check (autonomy in ('suggest_only','approval_required','autonomous_within_limits')),
  config              jsonb not null default '{}'::jsonb,
  daily_budget_usd    numeric(10,2) not null default 1.00 check (daily_budget_usd >= 0 and daily_budget_usd <= 100),
  max_actions_per_day integer not null default 20 check (max_actions_per_day between 0 and 500),
  last_run_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (character_id, role),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index agents_workspace_idx on public.agents(workspace_id);
create trigger agents_updated_at before update on public.agents
  for each row execute function private.set_updated_at();

create table public.agent_tasks (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  agent_id            uuid not null,
  parent_task_id      uuid references public.agent_tasks(id) on delete set null,
  created_by_agent_id uuid references public.agents(id) on delete set null,
  created_by_user     uuid references auth.users(id) on delete set null,
  type                text not null check (type ~ '^[a-z][a-z0-9_]{1,62}$'),
  title               text not null check (length(title) between 1 and 300),
  input               jsonb not null default '{}'::jsonb,
  priority            text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status              text not null default 'proposed'
                        check (status in ('proposed','pending','queued','running','awaiting_approval','completed','failed','cancelled')),
  requires_approval   boolean not null default true,
  approved_by         uuid references auth.users(id) on delete set null,
  approved_at         timestamptz,
  scheduled_for       timestamptz,
  attempts            integer not null default 0 check (attempts >= 0),
  max_attempts        integer not null default 3 check (max_attempts between 1 and 10),
  last_error          text,
  result              jsonb,
  idempotency_key     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  -- Composite FKs keep every reference inside the same workspace.
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (agent_id, workspace_id) references public.agents(id, workspace_id) on delete cascade,
  constraint agent_tasks_approval_recorded check (
    not requires_approval or status in ('proposed','awaiting_approval','cancelled') or approved_at is not null
  )
);
create index agent_tasks_workspace_status_idx on public.agent_tasks(workspace_id, status);
create index agent_tasks_agent_idx on public.agent_tasks(agent_id);
create index agent_tasks_character_idx on public.agent_tasks(character_id);
create index agent_tasks_parent_idx on public.agent_tasks(parent_task_id);
create index agent_tasks_claimable_idx on public.agent_tasks(priority, scheduled_for)
  where status in ('pending','queued');
create trigger agent_tasks_updated_at before update on public.agent_tasks
  for each row execute function private.set_updated_at();

create table public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  agent_task_id uuid not null,
  agent_id      uuid not null,
  character_id  uuid not null,
  status        text not null default 'running'
                  check (status in ('running','succeeded','failed','cancelled','budget_exceeded','policy_blocked')),
  model         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(10,6) not null default 0,
  output        jsonb,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (agent_task_id, workspace_id) references public.agent_tasks(id, workspace_id) on delete cascade,
  foreign key (agent_id, workspace_id) references public.agents(id, workspace_id) on delete cascade,
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index agent_runs_workspace_started_idx on public.agent_runs(workspace_id, started_at desc);
create index agent_runs_task_idx on public.agent_runs(agent_task_id);
create index agent_runs_agent_idx on public.agent_runs(agent_id);
create index agent_runs_character_idx on public.agent_runs(character_id);

create table public.agent_run_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_run_id uuid not null,
  seq          integer not null,
  type         text not null check (type in ('message','tool_call','tool_result','decision','policy_block','error')),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (agent_run_id, seq),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete cascade
);
create index agent_run_events_workspace_idx on public.agent_run_events(workspace_id);

-- ── RLS: members read; writes server-only ────────────────────────────────────
alter table public.agents           enable row level security;
alter table public.agent_tasks      enable row level security;
alter table public.agent_runs       enable row level security;
alter table public.agent_run_events enable row level security;

revoke all on public.agents, public.agent_tasks, public.agent_runs, public.agent_run_events from anon;
revoke insert, update, delete, truncate on public.agents, public.agent_tasks, public.agent_runs, public.agent_run_events from authenticated;

create policy agents_select on public.agents for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
create policy agent_tasks_select on public.agent_tasks for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
create policy agent_runs_select on public.agent_runs for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
create policy agent_run_events_select on public.agent_run_events for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));

-- Worker claim: atomically moves approved, due tasks to 'running' so parallel
-- workers never double-execute. Service role only. Only tasks whose agent is
-- ACTIVE are claimable — a disabled/paused agent's queue never runs.
create or replace function public.claim_agent_tasks(p_limit integer default 5)
returns setof public.agent_tasks
language sql security definer set search_path = '' as $$
  update public.agent_tasks t
     set status = 'running', attempts = t.attempts + 1, updated_at = now()
   where t.id in (
     select q.id from public.agent_tasks q
       join public.agents a on a.id = q.agent_id
      where q.status in ('pending','queued')
        and a.status = 'active'
        and (q.scheduled_for is null or q.scheduled_for <= now())
        and q.attempts < q.max_attempts
      order by case q.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
               q.created_at
      limit greatest(1, least(p_limit, 50))
      for update of q skip locked
   )
  returning t.*;
$$;
revoke all on function public.claim_agent_tasks(integer) from public, anon, authenticated;
grant execute on function public.claim_agent_tasks(integer) to service_role;

alter publication supabase_realtime add table public.agent_tasks, public.agent_runs;
