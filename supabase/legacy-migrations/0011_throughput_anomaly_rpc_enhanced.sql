-- ============================================================
-- Enhanced Throughput Anomaly Detection with pg_notify
-- Implements real-time alerting for task completion anomalies
-- ============================================================

-- ============================================================
-- 1. Ensure task_throughput_events table exists with full schema
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

-- ============================================================
-- 2. Create indexes for efficient querying
-- ============================================================
create index if not exists idx_throughput_events_detected_at
  on public.task_throughput_events(detected_at desc);

create index if not exists idx_throughput_events_anomaly
  on public.task_throughput_events(anomaly_detected) 
  where anomaly_detected = true;

create index if not exists idx_throughput_events_dismissed
  on public.task_throughput_events(dismissed_at) 
  where dismissed_at is null;

create index if not exists idx_throughput_events_window_z_score
  on public.task_throughput_events(window_minutes, z_score_threshold)
  where anomaly_detected = true;

-- ============================================================
-- 3. Enable RLS and policies
-- ============================================================
alter table public.task_throughput_events enable row level security;

drop policy if exists "anon_select_throughput" on public.task_throughput_events;
drop policy if exists "anon_insert_throughput" on public.task_throughput_events;
drop policy if exists "anon_update_throughput" on public.task_throughput_events;

create policy "anon_select_throughput" on public.task_throughput_events
  for select to anon using (true);

create policy "anon_insert_throughput" on public.task_throughput_events
  for insert to anon with check (true);

create policy "anon_update_throughput" on public.task_throughput_events
  for update to anon using (true) with check (true);

-- ============================================================
-- 4. Enable realtime for real-time subscriptions
-- ============================================================
alter publication supabase_realtime add table public.task_throughput_events;
alter table public.task_throughput_events replica identity full;

-- ============================================================
-- 5. Auto-update updated_at timestamp
-- ============================================================
drop trigger if exists task_throughput_events_updated_at on public.task_throughput_events;

create trigger task_throughput_events_updated_at
  before update on public.task_throughput_events
  for each row 
  execute procedure public.handle_updated_at();

-- ============================================================
-- 6. Enhanced get_task_throughput_anomaly RPC Function
--
-- DESCRIPTION:
--   Computes rolling mean and standard deviation of task completion
--   rates using a sliding window model. Detects statistically significant
--   throughput drops using z-score analysis and sends pg_notify alerts
--   for real-time monitoring.
--
-- ALGORITHM:
--   1. Calculate task completion rate in current window (past N minutes)
--   2. Calculate historical rates from 3 prior windows of N minutes each
--   3. Compute mean and standard deviation of historical rates
--   4. Calculate z-score: (current_rate - mean) / stdev
--   5. Flag anomaly if z-score < threshold (default -2.0 = 2σ below mean)
--   6. Persist event to task_throughput_events table
--   7. Send pg_notify on throughput_anomalies channel if anomaly detected
--
-- PARAMETERS:
--   p_window_minutes (int): Size of sliding window in minutes
--     - Recommended: 60 (hourly), 120 (2-hourly), 30 (30-minute buckets)
--     - Higher values = more stable baseline, slower anomaly detection
--     - Lower values = faster detection, more false positives
--
--   p_z_score_threshold (float): Z-score threshold for anomaly flagging
--     - -2.0 = anomaly at 2 standard deviations below mean (~95% confidence)
--     - -1.5 = anomaly at 1.5 standard deviations below mean (~93% confidence)
--     - Lower threshold = fewer alerts, higher false negative rate
--     - Higher threshold (closer to 0) = more alerts, higher false positive rate
--
-- RETURNS:
--   anomaly_detected (boolean): True if anomaly detected
--   window_minutes (int): Echo of input window size
--   z_score_threshold (float): Echo of input threshold
--   completion_rate (float): Tasks completed in current window
--   rolling_mean (float): Mean completion rate across 3 historical windows
--   rolling_stdev (float): Standard deviation of completion rates
--   z_score (float): Computed z-score for current window
--   anomaly_reason (text): Human-readable explanation (null if no anomaly)
--   detected_at (timestamptz): Timestamp of detection
--
-- REAL-TIME ALERTING:
--   When anomaly_detected = true, function sends pg_notify with payload:
--   {
--     "event_id": "uuid",
--     "anomaly_detected": true,
--     "completion_rate": float,
--     "rolling_mean": float,
--     "rolling_stdev": float,
--     "z_score": float,
--     "reason": string,
--     "detected_at": timestamptz,
--     "window_minutes": int
--   }
--
-- USAGE:
--   -- Check for hourly throughput anomalies at 2σ threshold
--   SELECT * FROM public.get_task_throughput_anomaly(60, -2.0);
--
--   -- Check for 30-minute throughput anomalies at 1.5σ threshold
--   SELECT * FROM public.get_task_throughput_anomaly(30, -1.5);
--
--   -- Subscribe to real-time alerts (from client):
--   supabase
--     .channel('throughput_anomalies')
--     .on('postgres_changes', {
--       event: 'INSERT',
--       schema: 'public',
--       table: 'task_throughput_events',
--       filter: 'anomaly_detected=eq.true'
--     }, (payload) => {
--       console.log('Anomaly detected:', payload.new);
--     })
--     .subscribe();
--
-- ============================================================
create or replace function public.get_task_throughput_anomaly(
  p_window_minutes int default 60,
  p_z_score_threshold float default -2.0
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
begin
  v_detected_at := now();
  v_current_window_start := v_detected_at - (p_window_minutes || ' minutes')::interval;

  -- ============================================================
  -- Step 1: Calculate completion rate in current window
  -- Count tasks with status change to 'completed' in current window
  -- ============================================================
  select coalesce(count(*)::float, 0)
  into v_current_rate
  from public.task_history th
  where th.changed_at >= v_current_window_start
    and th.action = 'status_change'
    and th.new_values->>'status' = 'completed';

  -- ============================================================
  -- Step 2: Calculate historical completion rates
  -- Get rates from prior 3 windows to establish baseline
  -- Each window is p_window_minutes in size
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

      select coalesce(count(*)::float, 0)
      into v_window_rate
      from public.task_history th
      where th.changed_at >= v_window_start
        and th.changed_at < v_window_end
        and th.action = 'status_change'
        and th.new_values->>'status' = 'completed';

      v_historical_rates := array_append(v_historical_rates, v_window_rate);
    end;
  end loop;

  -- ============================================================
  -- Step 3: Calculate mean of historical rates
  -- ============================================================
  if array_length(v_historical_rates, 1) > 0 then
    select coalesce(avg(val), 0)
    into v_mean
    from unnest(v_historical_rates) as val;
  else
    v_mean := 0;
  end if;

  -- ============================================================
  -- Step 4: Calculate standard deviation of historical rates
  -- Use population stddev for stability; avoid division by zero
  -- ============================================================
  if array_length(v_historical_rates, 1) > 1 then
    select coalesce(stddev_pop(val), 0)
    into v_stdev
    from unnest(v_historical_rates) as val;
  else
    v_stdev := 0;
  end if;

  -- Avoid division by zero: if stdev is 0, set to 1 (neutral z-score)
  if v_stdev is null or v_stdev = 0 then
    v_stdev := 1;
  end if;

  -- ============================================================
  -- Step 5: Calculate z-score for current window
  -- z_score = (current_rate - mean) / stdev
  -- Negative z-score indicates throughput drop below baseline
  -- ============================================================
  v_z_score := (v_current_rate - v_mean) / v_stdev;

  -- ============================================================
  -- Step 6: Detect anomaly (z-score below threshold)
  -- Lower threshold catches bigger drops; higher catches smaller ones
  -- ============================================================
  v_is_anomaly := v_z_score < p_z_score_threshold;

  -- ============================================================
  -- Step 7: Generate anomaly reason message
  -- ============================================================
  if v_is_anomaly then
    v_reason := format(
      'Throughput drop detected: rate=%.1f (z=%.2f, threshold=%.1f, mean=%.1f)',
      v_current_rate, v_z_score, p_z_score_threshold, v_mean
    );
  else
    v_reason := null;
  end if;

  -- ============================================================
  -- Step 8: Persist event to task_throughput_events table
  -- Maintains audit trail of all anomaly detections
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
  -- Step 9: Send pg_notify for real-time alerting
  -- Triggers real-time subscriptions on anomaly_detected = true
  -- Clients can subscribe and receive instant notifications
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
  -- Step 10: Return computed values
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
$$ security definer;

-- Grant execute permissions to anon role
grant execute on function public.get_task_throughput_anomaly(int, float) to anon, authenticated, service_role;

comment on function public.get_task_throughput_anomaly(int, float) is 
'Detects throughput anomalies using rolling window z-score analysis with real-time pg_notify alerting';
