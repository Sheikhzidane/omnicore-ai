-- ============================================================
-- pg_cron Job for Automatic DLQ Task Requeuing
-- Runs every 30 seconds to requeue eligible tasks
-- ============================================================

-- First, ensure pg_cron extension is enabled
create extension if not exists pg_cron with schema extensions;

-- ============================================================
-- Create the auto-requeue function called by cron
-- ============================================================
create or replace function public.dlq_auto_requeue_job()
returns table(
  requeued_count integer,
  skipped_count integer,
  message text
) language plpgsql as $$
declare
  v_requeued_count integer := 0;
  v_skipped_count integer := 0;
  v_dlq_id uuid;
  v_task_id uuid;
  v_retry_count integer;
  v_max_retries integer;
begin
  -- Find all DLQ entries that are eligible for retry
  for v_dlq_id, v_task_id, v_retry_count, v_max_retries in
    select 
      dlq.id,
      dlq.task_id,
      dlq.retry_count,
      dlq.max_retries
    from public.tasks_failed_dlq dlq
    where dlq.next_retry_at is not null
      and now() >= dlq.next_retry_at
      and dlq.retry_count < dlq.max_retries
    limit 100  -- Process max 100 per run to avoid overwhelming
  loop
    begin
      -- Attempt to requeue the task
      perform public.requeue_task(v_task_id);
      v_requeued_count := v_requeued_count + 1;
    exception when others then
      v_skipped_count := v_skipped_count + 1;
    end;
  end loop;

  return query select 
    v_requeued_count,
    v_skipped_count,
    format('Requeued %s tasks, skipped %s', v_requeued_count, v_skipped_count)::text;
end;
$$;

-- ============================================================
-- Schedule the cron job to run every 30 seconds
-- The schedule string "*/30 * * * * *" is in standard cron format
-- but pg_cron extends it to include seconds as the first field
-- ============================================================
-- First, delete any existing job with the same name
select cron.unschedule('dlq-auto-requeue') where exists (
  select 1 from cron.job where jobname = 'dlq-auto-requeue'
);

-- Schedule new job
select cron.schedule(
  'dlq-auto-requeue',
  '*/30 * * * * *',  -- Run every 30 seconds
  'select public.dlq_auto_requeue_job();'
);

-- ============================================================
-- Grant execute permission to service role
-- ============================================================
grant execute on function public.dlq_auto_requeue_job() to anon, authenticated, service_role;

-- ============================================================
-- Create a monitoring function to see cron job status
-- ============================================================
create or replace function public.get_dlq_cron_status()
returns table(
  jobname text,
  schedule text,
  command text,
  nodename text,
  nodeport integer,
  database text,
  username text,
  active boolean
) language sql stable as $$
  select 
    j.jobname,
    j.schedule,
    j.command,
    j.nodename,
    j.nodeport,
    j.database,
    j.username,
    j.active
  from cron.job j
  where j.jobname = 'dlq-auto-requeue';
$$;

grant execute on function public.get_dlq_cron_status() to anon, authenticated;

-- ============================================================
-- Create a function to get recent requeue activity logs
-- (for monitoring and debugging)
-- ============================================================
create table if not exists public.dlq_requeue_logs (
  id uuid primary key default gen_random_uuid(),
  dlq_id uuid not null references public.tasks_failed_dlq(id) on delete cascade,
  task_id uuid not null references public.todos(id) on delete cascade,
  retry_count integer not null,
  next_retry_at timestamptz,
  requeued_at timestamptz not null default now(),
  success boolean not null,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_dlq_requeue_logs_task_id 
  on public.dlq_requeue_logs(task_id);

create index if not exists idx_dlq_requeue_logs_requeued_at 
  on public.dlq_requeue_logs(requeued_at);

-- Enable realtime for logs
alter publication supabase_realtime add table public.dlq_requeue_logs;

-- Create policy for logs table
alter table public.dlq_requeue_logs enable row level security;

create policy "anon_select_logs" on public.dlq_requeue_logs
  for select to anon using (true);

create policy "anon_insert_logs" on public.dlq_requeue_logs
  for insert to anon with check (true);

-- ============================================================
-- Modify requeue_task to log requeue attempts
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
    insert into public.dlq_requeue_logs (dlq_id, task_id, retry_count, next_retry_at, success, error_message)
    values (v_dlq_id, p_task_id, v_retry_count, null, false, 'Max retries exceeded');
    
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

  -- Log the requeue attempt
  insert into public.dlq_requeue_logs (dlq_id, task_id, retry_count, next_retry_at, success, error_message)
  values (v_dlq_id, p_task_id, v_retry_count, v_next_retry_at, true, null);

  return query select 
    true, 
    format('Task requeued. Next retry in %s seconds', v_computed_backoff)::text,
    v_next_retry_at;
end;
$$;

-- ============================================================
-- Grant permissions for log operations
-- ============================================================
grant select, insert on public.dlq_requeue_logs to anon, authenticated;
