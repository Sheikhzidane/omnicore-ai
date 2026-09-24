-- ============================================================================
-- Human approval system + the 15-role agent roster.
--
-- agent_approvals is the single queue for every sensitive / real-world action
-- (publishing, external messages, outreach, credential and policy changes,
-- financial actions, engagement replies, canon memory updates).
--
-- The state machine is enforced by a TRIGGER, so no code path — including
-- the service role — can skip a state or approve without a human:
--
--   DRAFT ──► AWAITING_APPROVAL ──► APPROVED ──► EXECUTING ──► COMPLETED
--                     │                                  └──► FAILED ──► AWAITING_APPROVAL (retry needs re-approval)
--                     └──► REJECTED
--
-- APPROVED / REJECTED require decided_by = a human (auth.users). Agents never
-- appear in decided_by. An approval expires if not decided by expires_at.
-- ============================================================================

do $$ begin
  if to_regclass('public.agent_approvals') is not null then
    raise exception 'Preflight: public.agent_approvals already exists. See supabase/migrations/README.md.';
  end if;
end $$;

-- ── 15 agent roles ──────────────────────────────────────────────────────────
alter table public.agents drop constraint agents_role_check;
alter table public.agents add constraint agents_role_check check (role in (
  'ceo','character','trend_research','creative_director','content_planner','copywriter',
  'image_prompt','video_script','quality','safety','publishing','community',
  'growth_analyst','sales','finance_analyst'
));

-- ── agent_approvals ─────────────────────────────────────────────────────────
create table public.agent_approvals (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  character_id          uuid,
  action_type           text not null check (action_type in (
                          'publish_content','send_external_message','brand_outreach','change_social_credentials',
                          'financial_action','change_publishing_policy','engagement_reply','memory_update','agent_task')),
  entity_type           text not null check (entity_type ~ '^[a-z_]{2,40}$'),
  entity_id             uuid,
  title                 text not null check (length(title) between 1 and 300),
  summary               text check (length(summary) <= 4000),
  payload               jsonb not null default '{}'::jsonb,
  risk_level            text not null default 'medium' check (risk_level in ('low','medium','high')),
  status                text not null default 'DRAFT' check (status in (
                          'DRAFT','AWAITING_APPROVAL','APPROVED','REJECTED','EXECUTING','COMPLETED','FAILED')),
  requested_by_type     text not null check (requested_by_type in ('user','agent','system')),
  requested_by_user     uuid references auth.users(id) on delete set null,
  requested_by_agent_id uuid,
  agent_run_id          uuid,
  decided_by            uuid references auth.users(id) on delete set null,
  decided_at            timestamptz,
  decision_note         text check (length(decision_note) <= 2000),
  executed_at           timestamptz,
  completed_at          timestamptz,
  result                jsonb,
  error                 text check (length(error) <= 2000),
  expires_at            timestamptz,
  idempotency_key       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (requested_by_agent_id, workspace_id) references public.agents(id, workspace_id) on delete set null (requested_by_agent_id),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id),
  constraint agent_approvals_requester_consistent check (
    (requested_by_type = 'agent' and requested_by_agent_id is not null)
    or (requested_by_type = 'user' and requested_by_user is not null)
    or requested_by_type = 'system'
  ),
  constraint agent_approvals_decision_recorded check (
    status in ('DRAFT','AWAITING_APPROVAL') or (decided_by is not null and decided_at is not null)
  )
);
create index agent_approvals_queue_idx on public.agent_approvals(workspace_id, status, created_at desc);
create index agent_approvals_entity_idx on public.agent_approvals(entity_type, entity_id);
create index agent_approvals_character_idx on public.agent_approvals(character_id);
create trigger agent_approvals_updated_at before update on public.agent_approvals
  for each row execute function private.set_updated_at();

create or replace function private.approval_transition_guard()
returns trigger language plpgsql set search_path = '' as $$
declare allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('DRAFT','AWAITING_APPROVAL') then
      raise exception 'approvals must be created as DRAFT or AWAITING_APPROVAL (got %)', new.status;
    end if;
    return new;
  end if;

  -- Immutable identity of the request.
  if new.workspace_id <> old.workspace_id or new.action_type <> old.action_type
     or new.entity_type <> old.entity_type or new.entity_id is distinct from old.entity_id
     or new.requested_by_type <> old.requested_by_type then
    raise exception 'approval request identity is immutable';
  end if;
  -- The approved payload cannot change after submission.
  if old.status <> 'DRAFT' and new.payload is distinct from old.payload then
    raise exception 'approval payload cannot change after submission';
  end if;

  if new.status = old.status then return new; end if;

  allowed := (old.status, new.status) in (
    ('DRAFT','AWAITING_APPROVAL'),
    ('AWAITING_APPROVAL','APPROVED'), ('AWAITING_APPROVAL','REJECTED'),
    ('APPROVED','EXECUTING'),
    ('EXECUTING','COMPLETED'), ('EXECUTING','FAILED'),
    ('FAILED','AWAITING_APPROVAL')
  );
  if not allowed then
    raise exception 'invalid approval transition % -> %', old.status, new.status;
  end if;

  if new.status in ('APPROVED','REJECTED') then
    if new.decided_by is null then raise exception 'a human decision (decided_by) is required'; end if;
    if new.expires_at is not null and new.expires_at < now() then raise exception 'approval request has expired'; end if;
    new.decided_at := coalesce(new.decided_at, now());
  end if;
  if new.status = 'EXECUTING' then new.executed_at := now(); end if;
  if new.status in ('COMPLETED','FAILED') then new.completed_at := now(); end if;
  if old.status = 'FAILED' and new.status = 'AWAITING_APPROVAL' then
    -- A retry needs a fresh human decision.
    new.decided_by := null; new.decided_at := null; new.decision_note := null;
  end if;
  return new;
end;
$$;

create trigger agent_approvals_state_machine before insert or update on public.agent_approvals
  for each row execute function private.approval_transition_guard();

-- Link agent tasks to the approval that authorised them.
alter table public.agent_tasks add column approval_id uuid;
alter table public.agent_tasks add constraint agent_tasks_approval_fk
  foreign key (approval_id, workspace_id) references public.agent_approvals(id, workspace_id) on delete set null (approval_id);
create index agent_tasks_approval_idx on public.agent_tasks(approval_id);

select private.apply_workspace_rls('public.agent_approvals');
