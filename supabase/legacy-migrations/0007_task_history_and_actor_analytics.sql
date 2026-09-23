-- ============================================================
-- Task History Table with Audit Trail
-- ============================================================
create table if not exists public.task_history (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references public.todos(id) on delete cascade,
  actor_id       uuid not null,
  actor_name     text,
  action         text not null,
  changed_at     timestamptz not null default now(),
  old_values     jsonb not null default '{}'::jsonb,
  new_values     jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

-- ============================================================
-- Indexes
-- ============================================================

-- Compound partial index for efficient status-change queries per actor
create index if not exists idx_task_history_actor_status_changes
  on public.task_history(changed_at desc, actor_id)
  where new_values ? 'status';

-- Additional indexes for common queries
create index if not exists idx_task_history_task_id
  on public.task_history(task_id);

create index if not exists idx_task_history_actor_id
  on public.task_history(actor_id);

create index if not exists idx_task_history_changed_at
  on public.task_history(changed_at desc);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.task_history enable row level security;

create policy "anon_select" on public.task_history
  for select to anon using (true);

create policy "anon_insert" on public.task_history
  for insert to anon with check (true);

-- ============================================================
-- Realtime
-- ============================================================
alter publication supabase_realtime add table public.task_history;
alter table public.task_history replica identity full;

-- ============================================================
-- RPC Function: get_actor_activity_summary
-- Aggregates per-actor statistics including:
--   - Status transition count
--   - Total action count
--   - Average time between actions (in seconds)
--   - Last and first seen timestamps
-- ============================================================
create or replace function public.get_actor_activity_summary(
  actor_id uuid,
  since_at timestamptz default now() - interval '30 days'
)
returns table (
  actor_id uuid,
  actor_name text,
  status_transition_count bigint,
  total_actions bigint,
  average_time_between_actions_seconds numeric,
  last_seen_at timestamptz,
  first_seen_at timestamptz
) language sql stable as $$
  with actor_changes as (
    select 
      actor_id,
      actor_name,
      changed_at,
      new_values
    from public.task_history
    where task_history.actor_id = actor_id
      and task_history.changed_at >= since_at
  ),
  status_changes as (
    select count(*) as status_count
    from actor_changes
    where new_values ? 'status'
  ),
  time_deltas as (
    select 
      extract(epoch from (lead(changed_at) over (order by changed_at) - changed_at))::numeric as delta_seconds
    from actor_changes
    order by changed_at
  ),
  stats as (
    select 
      (select status_count from status_changes) as status_transitions,
      count(*) as total_action_count,
      avg(delta_seconds) as avg_delta
    from time_deltas
  )
  select 
    actor_id,
    (select actor_name from actor_changes limit 1),
    coalesce((select status_transitions from stats), 0::bigint),
    coalesce((select total_action_count from stats), (select count(*) from actor_changes)::bigint),
    coalesce((select avg_delta from stats), 0::numeric),
    (select max(changed_at) from actor_changes),
    (select min(changed_at) from actor_changes)
$$;

-- ============================================================
-- RPC Function: get_all_actor_activity_summaries
-- Returns activity summaries for all actors
-- ============================================================
create or replace function public.get_all_actor_activity_summaries(
  since_at timestamptz default now() - interval '30 days'
)
returns table (
  actor_id uuid,
  actor_name text,
  status_transition_count bigint,
  total_actions bigint,
  average_time_between_actions_seconds numeric,
  last_seen_at timestamptz,
  first_seen_at timestamptz
) language sql stable as $$
  select distinct on (th.actor_id)
    th.actor_id,
    th.actor_name,
    (select public.get_actor_activity_summary(th.actor_id, since_at)).status_transition_count,
    (select public.get_actor_activity_summary(th.actor_id, since_at)).total_actions,
    (select public.get_actor_activity_summary(th.actor_id, since_at)).average_time_between_actions_seconds,
    (select public.get_actor_activity_summary(th.actor_id, since_at)).last_seen_at,
    (select public.get_actor_activity_summary(th.actor_id, since_at)).first_seen_at
  from public.task_history th
  where th.changed_at >= since_at
  order by th.actor_id, th.changed_at desc
$$;
