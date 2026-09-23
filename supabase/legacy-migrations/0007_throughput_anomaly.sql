-- ============================================================
-- Throughput Anomaly Detection Infrastructure
-- Implements rolling mean/std deviation with z-score anomaly detection
-- ============================================================

-- ============================================================
-- 1. Create task_throughput_events table to track anomalies
-- ============================================================
create table if not exists public.task_throughput_events (
  id                uuid primary key default gen_random_uuid(),
  anomaly_detected  boolean not null,
  window_minutes    integer not null,
  z_score_threshold float not null,
  completion_rate   float,
  rolling_mean      float,
  rolling_stdev     float,
  z_score           float,
  anomaly_reason    text,
  detected_at       timestamptz not null default now(),
  dismissed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Create indexes for efficient querying and filtering
create index if not exists idx_throughput_events_detected_at
  on public.task_throughput_events(detected_at desc);

create index if not exists idx_throughput_events_anomaly
  on public.task_throughput_events(anomaly_detected) where anomaly_detected = true;

create index if not exists idx_throughput_events_dismissed
  on public.task_throughput_events(dismissed_at) where dismissed_at is null;

-- Enable RLS
alter table public.task_throughput_events enable row level security;

create policy "anon_select_throughput" on public.task_throughput_events
  for select to anon using (true);

create policy "anon_insert_throughput" on public.task_throughput_events
  for insert to anon with check (true);

create policy "anon_update_throughput" on public.task_throughput_events
  for update to anon using (true) with check (true);

-- Enable realtime
alter publication supabase_realtime add table public.task_throughput_events;
alter table public.task_throughput_events replica identity full;

-- Auto-update updated_at
create trigger task_throughput_events_updated_at
  before update on public.task_throughput_events
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- 2. Create get_task_throughput_anomaly function
-- 
-- Computes rolling mean and standard deviation of task completion
-- rates using a sliding window. Detects statistically significant
-- throughput drops using z-score analysis and sends pg_notify.
--
-- Parameters:
--   window_minutes: Size of sliding window in minutes (e.g., 60, 120)
--   z_score_threshold: Z-score threshold for anomaly flagging (e.g., -2.0)
--
-- Returns:
--   anomaly_detected: boolean indicating if anomaly was flagged
--   window_minutes: Input window size
--   z_score_threshold: Input threshold
--   completion_rate: Tasks completed in current window
--   rolling_mean: Mean completion rate across historical windows
--   rolling_stdev: Standard deviation of completion rates
--   z_score: Computed z-score for current window
--   anomaly_reason: Description of anomaly (if any)
-- ============================================================
create or replace function public.get_task_throughput_anomaly(
  p_window_minutes int,
  p_z_score_threshold float
)
returns table(
  anomaly_detected boolean,
  window_minutes int,
  z_score_threshold float,
  completion_rate float,
  rolling_mean float,
  rolling_stdev float,
  z_score float,
  anomaly_reason text,
  detected_at timestamptz
) language plpgsql as $$
declare
  v_current_window_start timestamptz;
  v_prior_window_start timestamptz;
  v_current_rate float;
  v_historical_rates float[];
  v_mean float;
  v_stdev float;
  v_z_score float;
  v_is_anomaly boolean;
  v_reason text;
  v_detected_at timestamptz;
  v_event_id uuid;
  i int;
  v_sum numeric;
  v_count int;
  v_variance numeric;
  v_rate_record record;
begin
  v_detected_at := now();
  v_current_window_start := v_detected_at - (p_window_minutes || ' minutes')::interval;
  v_prior_window_start := v_current_window_start - (p_window_minutes * 3 || ' minutes')::interval;

  -- ============================================================
  -- Step 1: Calculate completion rate in current window
  -- Count tasks with action 'completed' in current sliding window
  -- ============================================================
  select count(*)::float
  into v_current_rate
  from public.task_history th
  where th.changed_at >= v_current_window_start
    and th.action = 'status_change'
    and th.new_values->>'status' = 'completed';

  -- Handle zero rate case
  if v_current_rate is null then
    v_current_rate := 0;
  end if;

  -- ============================================================
  -- Step 2: Calculate historical completion rates
  -- Get rates from prior 3 windows to establish mean/stdev
  -- Each window is window_minutes in size
  -- ============================================================
  v_historical_rates := array[]::float[];

  for i in 0..2 loop
    declare
      v_window_start timestamptz;
      v_window_end timestamptz;
      v_window_rate float;
    begin
      v_window_start := v_current_window_start - ((i + 1) * p_window_minutes || ' minutes')::interval;
      v_window_end := v_window_start + (p_window_minutes || ' minutes')::interval;

      select count(*)::float
      into v_window_rate
      from public.task_history th
      where th.changed_at >= v_window_start
        and th.changed_at < v_window_end
        and th.action = 'status_change'
        and th.new_values->>'status' = 'completed';

      if v_window_rate is null then
        v_window_rate := 0;
      end if;

      v_historical_rates := array_append(v_historical_rates, v_window_rate);
    end;
  end loop;

  -- ============================================================
  -- Step 3: Calculate mean of historical rates
  -- ============================================================
  if array_length(v_historical_rates, 1) > 0 then
    select avg(val)
    into v_mean
    from unnest(v_historical_rates) as val;
  else
    v_mean := 0;
  end if;

  if v_mean is null then
    v_mean := 0;
  end if;

  -- ============================================================
  -- Step 4: Calculate standard deviation of historical rates
  -- ============================================================
  if array_length(v_historical_rates, 1) > 1 then
    select stddev_pop(val)
    into v_stdev
    from unnest(v_historical_rates) as val;
  else
    v_stdev := 0;
  end if;

  if v_stdev is null or v_stdev = 0 then
    v_stdev := 1; -- Avoid division by zero in z-score
  end if;

  -- ============================================================
  -- Step 5: Calculate z-score for current window
  -- z_score = (current_rate - mean) / stdev
  -- Negative z-score indicates throughput drop
  -- ============================================================
  v_z_score := (v_current_rate - v_mean) / v_stdev;

  -- ============================================================
  -- Step 6: Detect anomaly (z-score below threshold)
  -- Lower z-score threshold (e.g., -2.0) catches bigger drops
  -- ============================================================
  v_is_anomaly := v_z_score < p_z_score_threshold;

  if v_is_anomaly then
    v_reason := format(
      'Throughput drop detected: rate=%.1f (z=%.2f, threshold=%.1f)',
      v_current_rate, v_z_score, p_z_score_threshold
    );
  else
    v_reason := null;
  end if;

  -- ============================================================
  -- Step 7: Persist event to task_throughput_events table
  -- ============================================================
  insert into public.task_throughput_events (
    anomaly_detected,
    window_minutes,
    z_score_threshold,
    completion_rate,
    rolling_mean,
    rolling_stdev,
    z_score,
    anomaly_reason,
    detected_at
  ) values (
    v_is_anomaly,
    p_window_minutes,
    p_z_score_threshold,
    v_current_rate,
    v_mean,
    v_stdev,
    v_z_score,
    v_reason,
    v_detected_at
  )
  returning id into v_event_id;

  -- ============================================================
  -- Step 8: Send pg_notify if anomaly detected
  -- Channel: "throughput_anomalies"
  -- Payload: JSON with event details and ID
  -- ============================================================
  if v_is_anomaly then
    perform pg_notify(
      'throughput_anomalies',
      jsonb_build_object(
        'event_id', v_event_id,
        'anomaly_detected', true,
        'completion_rate', v_current_rate,
        'rolling_mean', v_mean,
        'rolling_stdev', v_stdev,
        'z_score', v_z_score,
        'reason', v_reason,
        'detected_at', v_detected_at,
        'window_minutes', p_window_minutes
      )::text
    );
  end if;

  -- ============================================================
  -- Step 9: Return results
  -- ============================================================
  return query select
    v_is_anomaly,
    p_window_minutes,
    p_z_score_threshold,
    v_current_rate,
    v_mean,
    v_stdev,
    v_z_score,
    v_reason,
    v_detected_at;
end;
$$;

-- Grant execute to service role
grant execute on function public.get_task_throughput_anomaly(int, float) to service_role, anon;

-- ============================================================
-- 3. Create dismiss_anomaly function
-- Marks an anomaly as dismissed by setting dismissed_at
-- ============================================================
create or replace function public.dismiss_anomaly(p_event_id uuid)
returns table(
  success boolean,
  message text
) language plpgsql as $$
declare
  v_rows_updated int;
begin
  update public.task_throughput_events
  set dismissed_at = now(), updated_at = now()
  where id = p_event_id and dismissed_at is null;

  get diagnostics v_rows_updated = row_count;

  if v_rows_updated > 0 then
    return query select true, 'Anomaly dismissed'::text;
  else
    return query select false, 'Anomaly not found or already dismissed'::text;
  end if;
end;
$$;

grant execute on function public.dismiss_anomaly(uuid) to service_role, anon;
