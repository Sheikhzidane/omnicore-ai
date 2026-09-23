-- ============================================================
-- Dead Letter Queue (DLQ) Infrastructure
-- Implements exponential backoff with jitter for task retries
-- ============================================================

-- ============================================================
-- 1. Create tasks_failed_dlq table
-- ============================================================
create table if not exists public.tasks_failed_dlq (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references public.todos(id) on delete cascade,
  original_status       text not null,
  failure_reason        text,
  retry_count           integer not null default 0,
  max_retries           integer not null default 5,
  base_backoff_seconds  integer not null default 60,
  first_failed_at       timestamptz not null default now(),
  last_failed_at        timestamptz not null default now(),
  next_retry_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Enable RLS for DLQ table
alter table public.tasks_failed_dlq enable row level security;

create policy "anon_select_dlq" on public.tasks_failed_dlq
  for select to anon using (true);

create policy "anon_insert_dlq" on public.tasks_failed_dlq
  for insert to anon with check (true);

create policy "anon_update_dlq" on public.tasks_failed_dlq
  for update to anon using (true) with check (true);

create policy "anon_delete_dlq" on public.tasks_failed_dlq
  for delete to anon using (true);

-- Enable realtime for DLQ
alter publication supabase_realtime add table public.tasks_failed_dlq;
alter table public.tasks_failed_dlq replica identity full;

-- Create indexes for performance
create index if not exists idx_tasks_failed_dlq_task_id 
  on public.tasks_failed_dlq(task_id);

create index if not exists idx_tasks_failed_dlq_next_retry 
  on public.tasks_failed_dlq(next_retry_at) 
  where next_retry_at is not null;

create index if not exists idx_tasks_failed_dlq_retry_count 
  on public.tasks_failed_dlq(retry_count);

-- Auto-update updated_at on DLQ changes
create trigger tasks_failed_dlq_updated_at
  before update on public.tasks_failed_dlq
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- 2. Create get_task_retry_backoff function
-- Computes exponential backoff with jitter
--
-- Formula: 
--   base_backoff_seconds * (2 ^ retry_count) + random jitter
-- Jitter: adds 0-20% of the computed backoff to prevent thundering herd
-- ============================================================
create or replace function public.get_task_retry_backoff(p_task_id uuid)
returns table(
  task_id uuid,
  retry_count integer,
  max_retries integer,
  base_backoff_seconds integer,
  computed_backoff_seconds integer,
  next_retry_at timestamptz,
  is_eligible boolean,
  time_until_retry_seconds integer
) language plpgsql as $$
declare
  v_retry_count integer;
  v_max_retries integer;
  v_base_backoff integer;
  v_computed_backoff integer;
  v_jitter_percentage numeric;
  v_jitter_seconds numeric;
  v_next_retry_at timestamptz;
  v_is_eligible boolean;
  v_time_until_retry integer;
begin
  -- Get DLQ entry for this task
  select 
    dlq.retry_count,
    dlq.max_retries,
    dlq.base_backoff_seconds,
    dlq.next_retry_at
  into 
    v_retry_count,
    v_max_retries,
    v_base_backoff,
    v_next_retry_at
  from public.tasks_failed_dlq dlq
  where dlq.task_id = p_task_id
  order by dlq.created_at desc
  limit 1;

  -- If no DLQ entry found, return empty result
  if v_retry_count is null then
    return;
  end if;

  -- Compute exponential backoff: base * (2 ^ retry_count)
  v_computed_backoff := v_base_backoff * (power(2, v_retry_count)::int);

  -- Add jitter (0-20% of computed backoff) to prevent thundering herd
  v_jitter_percentage := random() * 0.2;
  v_jitter_seconds := v_computed_backoff * v_jitter_percentage;
  v_computed_backoff := v_computed_backoff + v_jitter_seconds::int;

  -- If next_retry_at was not computed, compute it now
  if v_next_retry_at is null then
    v_next_retry_at := now() + (v_computed_backoff || ' seconds')::interval;
  end if;

  -- Check if this task is eligible for retry (max retries not exceeded and retry window passed)
  v_is_eligible := v_retry_count < v_max_retries and now() >= v_next_retry_at;

  -- Calculate time remaining until retry
  v_time_until_retry := extract(epoch from (v_next_retry_at - now()))::int;
  if v_time_until_retry < 0 then
    v_time_until_retry := 0;
  end if;

  -- Return computed backoff information
  return query select
    p_task_id,
    v_retry_count,
    v_max_retries,
    v_base_backoff,
    v_computed_backoff,
    v_next_retry_at,
    v_is_eligible,
    v_time_until_retry;
end;
$$;

-- ============================================================
-- 3. Create requeue_task function
-- Moves a task from DLQ back to 'pending' status
-- ============================================================
create or replace function public.requeue_task(p_task_id uuid)
returns table(
  success boolean,
  message text,
  next_retry_at timestamptz
) language plpgsql as $$
declare
  v_dlq_id uuid;
  v_retry_count integer;
  v_max_retries integer;
  v_base_backoff integer;
  v_next_retry_at timestamptz;
  v_computed_backoff integer;
  v_jitter_percentage numeric;
  v_jitter_seconds numeric;
begin
  -- Get the most recent DLQ entry
  select 
    dlq.id,
    dlq.retry_count,
    dlq.max_retries,
    dlq.base_backoff_seconds
  into 
    v_dlq_id,
    v_retry_count,
    v_max_retries,
    v_base_backoff
  from public.tasks_failed_dlq dlq
  where dlq.task_id = p_task_id
  order by dlq.created_at desc
  limit 1;

  -- If no DLQ entry, return error
  if v_dlq_id is null then
    return query select false, 'Task not found in DLQ'::text, null::timestamptz;
    return;
  end if;

  -- Check if max retries exceeded
  if v_retry_count >= v_max_retries then
    return query select false, format('Max retries (%s) exceeded', v_max_retries)::text, null::timestamptz;
    return;
  end if;

  -- Compute next retry time with exponential backoff + jitter
  v_computed_backoff := v_base_backoff * (power(2, v_retry_count)::int);
  v_jitter_percentage := random() * 0.2;
  v_jitter_seconds := v_computed_backoff * v_jitter_percentage;
  v_computed_backoff := v_computed_backoff + v_jitter_seconds::int;
  v_next_retry_at := now() + (v_computed_backoff || ' seconds')::interval;

  -- Update DLQ entry
  update public.tasks_failed_dlq
  set 
    next_retry_at = v_next_retry_at,
    last_failed_at = now(),
    updated_at = now()
  where id = v_dlq_id;

  -- Update the task status back to 'pending'
  update public.todos
  set status = 'pending', updated_at = now()
  where id = p_task_id;

  return query select 
    true, 
    format('Task requeued. Next retry in %s seconds', v_computed_backoff)::text,
    v_next_retry_at;
end;
$$;

-- ============================================================
-- 4. Create mark_task_failed function
-- Moves a task from any status to DLQ with failure tracking
-- ============================================================
create or replace function public.mark_task_failed(
  p_task_id uuid,
  p_failure_reason text default null,
  p_base_backoff_seconds integer default 60,
  p_max_retries integer default 5
)
returns table(
  success boolean,
  dlq_id uuid,
  message text
) language plpgsql as $$
declare
  v_dlq_entry_exists boolean;
  v_new_dlq_id uuid;
  v_current_status text;
begin
  -- Get current task status
  select status into v_current_status
  from public.todos
  where id = p_task_id;

  if v_current_status is null then
    return query select false, null::uuid, 'Task not found'::text;
    return;
  end if;

  -- Check if task already in DLQ (unresolved)
  select exists(
    select 1 from public.tasks_failed_dlq
    where task_id = p_task_id
    and next_retry_at is not null
  ) into v_dlq_entry_exists;

  if v_dlq_entry_exists then
    -- Increment retry count for existing DLQ entry
    update public.tasks_failed_dlq
    set 
      retry_count = retry_count + 1,
      last_failed_at = now(),
      failure_reason = p_failure_reason,
      updated_at = now()
    where task_id = p_task_id
    and next_retry_at is not null
    returning id into v_new_dlq_id;
  else
    -- Create new DLQ entry
    insert into public.tasks_failed_dlq (
      task_id,
      original_status,
      failure_reason,
      retry_count,
      max_retries,
      base_backoff_seconds,
      first_failed_at,
      last_failed_at
    ) values (
      p_task_id,
      v_current_status,
      p_failure_reason,
      0,
      p_max_retries,
      p_base_backoff_seconds,
      now(),
      now()
    ) returning id into v_new_dlq_id;
  end if;

  -- Update task status to 'failed'
  update public.todos
  set status = 'failed', updated_at = now()
  where id = p_task_id;

  return query select 
    true,
    v_new_dlq_id,
    'Task marked as failed and added to DLQ'::text;
end;
$$;

-- ============================================================
-- 5. Create get_dlq_tasks_with_retry_schedule function
-- Returns all DLQ tasks with computed retry schedules
-- Used for the DLQ management panel countdown timeline
-- ============================================================
create or replace function public.get_dlq_tasks_with_retry_schedule()
returns table(
  dlq_id uuid,
  task_id uuid,
  task_title text,
  original_status text,
  failure_reason text,
  retry_count integer,
  max_retries integer,
  base_backoff_seconds integer,
  next_retry_at timestamptz,
  is_eligible boolean,
  time_until_retry_seconds integer,
  first_failed_at timestamptz,
  last_failed_at timestamptz
) language plpgsql as $$
begin
  return query
  select
    dlq.id,
    dlq.task_id,
    t.title,
    dlq.original_status,
    dlq.failure_reason,
    dlq.retry_count,
    dlq.max_retries,
    dlq.base_backoff_seconds,
    dlq.next_retry_at,
    (dlq.retry_count < dlq.max_retries and now() >= dlq.next_retry_at) as is_eligible,
    greatest(0, extract(epoch from (dlq.next_retry_at - now()))::int) as time_until_retry_seconds,
    dlq.first_failed_at,
    dlq.last_failed_at
  from public.tasks_failed_dlq dlq
  left join public.todos t on dlq.task_id = t.id
  where dlq.next_retry_at is not null
  order by dlq.next_retry_at asc;
end;
$$;

-- ============================================================
-- 6. Grant necessary permissions
-- ============================================================
grant execute on function public.get_task_retry_backoff(uuid) to anon, authenticated;
grant execute on function public.requeue_task(uuid) to anon, authenticated;
grant execute on function public.mark_task_failed(uuid, text, integer, integer) to anon, authenticated;
grant execute on function public.get_dlq_tasks_with_retry_schedule() to anon, authenticated;

grant select on public.tasks_failed_dlq to anon, authenticated;
grant insert, update, delete on public.tasks_failed_dlq to anon, authenticated;
