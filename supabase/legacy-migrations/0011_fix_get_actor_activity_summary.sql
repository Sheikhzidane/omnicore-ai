-- ============================================================
-- Fix and Optimize get_actor_activity_summary RPC
-- ============================================================
-- This migration fixes the actor_id parameter shadowing issue
-- and improves the overall performance and correctness of the RPC function.

-- ============================================================
-- Drop and Recreate RPC Function: get_actor_activity_summary
-- Optimized version with proper parameter handling and aggregations
-- ============================================================
drop function if exists public.get_actor_activity_summary(uuid, timestamptz) cascade;

create or replace function public.get_actor_activity_summary(
  p_actor_id uuid,
  p_since_at timestamptz default now() - interval '30 days'
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
      th.actor_id,
      th.actor_name,
      th.changed_at,
      th.new_values,
      lead(th.changed_at) over (order by th.changed_at) as next_changed_at
    from public.task_history th
    where th.actor_id = p_actor_id
      and th.changed_at >= p_since_at
    order by th.changed_at
  ),
  stats as (
    select 
      count(*) filter (where new_values ? 'status') as status_transitions,
      count(*) as total_action_count,
      nullif(avg(extract(epoch from (next_changed_at - changed_at))), 0)::numeric as avg_time_delta,
      max(changed_at) as last_seen,
      min(changed_at) as first_seen,
      max(actor_name) filter (where actor_name is not null) as latest_actor_name
    from actor_changes
  )
  select 
    p_actor_id,
    coalesce((select latest_actor_name from stats), ''),
    coalesce((select status_transitions from stats), 0::bigint),
    coalesce((select total_action_count from stats), 0::bigint),
    coalesce((select avg_time_delta from stats), 0::numeric),
    (select last_seen from stats),
    (select first_seen from stats)
$$;

-- ============================================================
-- Drop and Recreate RPC Function: get_all_actor_activity_summaries
-- Returns activity summaries for all actors efficiently
-- ============================================================
drop function if exists public.get_all_actor_activity_summaries(timestamptz) cascade;

create or replace function public.get_all_actor_activity_summaries(
  p_since_at timestamptz default now() - interval '30 days'
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
    where th.changed_at >= p_since_at
    group by th.actor_id
  ),
  time_deltas_per_actor as (
    select 
      th.actor_id,
      avg(extract(epoch from (lead(th.changed_at) over (partition by th.actor_id order by th.changed_at) - th.changed_at)))::numeric as avg_time_delta
    from public.task_history th
    where th.changed_at >= p_since_at
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

-- ============================================================
-- Comments for documentation
-- ============================================================
comment on function public.get_actor_activity_summary(uuid, timestamptz) is
'Get activity summary for a specific actor.

Parameters:
  - p_actor_id: UUID of the actor to summarize
  - p_since_at: Timestamp to filter activities from (default: 30 days ago)

Returns:
  - actor_id: The actor UUID
  - actor_name: The actor name (latest available)
  - status_transition_count: Number of status changes made by the actor
  - total_actions: Total number of actions performed by the actor
  - average_time_between_actions_seconds: Average seconds between consecutive actions
  - last_seen_at: Timestamp of most recent action
  - first_seen_at: Timestamp of oldest action in period';

comment on function public.get_all_actor_activity_summaries(timestamptz) is
'Get activity summaries for all actors.

Parameters:
  - p_since_at: Timestamp to filter activities from (default: 30 days ago)

Returns:
  Same columns as get_actor_activity_summary, but for all actors
  ordered by last_seen_at descending.';
