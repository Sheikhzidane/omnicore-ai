-- ============================================================
-- Partial Index for get_actor_activity_summary RPC
-- ============================================================
-- This partial index optimizes the get_actor_activity_summary function
-- by indexing only non-NULL records that are needed for activity summaries.
-- The filter excludes old records and focuses on recent activity.

create index if not exists idx_task_history_actor_activity
  on public.task_history(actor_id, changed_at desc)
  where actor_id is not null 
    and changed_at >= now() - interval '90 days';

-- Additional partial index specifically for status transitions
-- This supports the status_transition_count calculation in the RPC
create index if not exists idx_task_history_actor_status_transition
  on public.task_history(actor_id, changed_at desc)
  where actor_id is not null
    and new_values ? 'status'
    and changed_at >= now() - interval '90 days';

-- ============================================================
-- Improved RPC Function: get_actor_activity_summary
-- Optimized version with better performance characteristics
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
    where task_history.actor_id = $1
      and task_history.changed_at >= $2
    order by changed_at
  ),
  time_deltas as (
    select 
      extract(epoch from (lead(changed_at) over (order by changed_at) - changed_at))::numeric as delta_seconds
    from actor_changes
  ),
  stats as (
    select 
      count(*) filter (where new_values ? 'status') as status_transitions,
      count(*) as total_action_count,
      nullif(avg(delta_seconds), 0) as avg_delta,
      max(changed_at) as last_seen,
      min(changed_at) as first_seen,
      max(actor_name) filter (where actor_name is not null) as latest_actor_name
    from (
      select changed_at, new_values, actor_name from actor_changes
    ) t
    cross join lateral (
      select delta_seconds from time_deltas
    ) td on true
  )
  select 
    $1,
    coalesce((select latest_actor_name from stats), ''),
    coalesce((select status_transitions from stats), 0::bigint),
    coalesce((select total_action_count from stats), 0::bigint),
    coalesce((select avg_delta from stats), 0::numeric),
    (select last_seen from stats),
    (select first_seen from stats)
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
  with actor_summary as (
    select 
      th.actor_id,
      max(th.actor_name) filter (where th.actor_name is not null) as actor_name,
      count(*) as total_actions,
      count(*) filter (where th.new_values ? 'status') as status_transitions,
      max(th.changed_at) as last_seen_at,
      min(th.changed_at) as first_seen_at
    from public.task_history th
    where th.changed_at >= $1
    group by th.actor_id
  ),
  time_deltas_per_actor as (
    select 
      th.actor_id,
      avg(extract(epoch from (lead(th.changed_at) over (partition by th.actor_id order by th.changed_at) - th.changed_at)))::numeric as avg_time_delta
    from public.task_history th
    where th.changed_at >= $1
    group by th.actor_id
  )
  select 
    asa.actor_id,
    asa.actor_name,
    asa.status_transitions,
    asa.total_actions,
    coalesce(td.avg_time_delta, 0::numeric),
    asa.last_seen_at,
    asa.first_seen_at
  from actor_summary asa
  left join time_deltas_per_actor td on asa.actor_id = td.actor_id
  order by asa.last_seen_at desc
$$;
