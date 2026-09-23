-- ============================================================
-- Connection Quality Events Anomaly Dismissal Infrastructure
-- Adds dismissal tracking to connection_quality_events table
-- ============================================================

-- ============================================================
-- 1. Add dismissal columns to connection_quality_events table
-- ============================================================

-- Check if columns already exist before adding them
alter table if exists public.connection_quality_events
add column if not exists dismissed_at timestamptz;

alter table if exists public.connection_quality_events
add column if not exists resolution_notes text;

alter table if exists public.connection_quality_events
add column if not exists updated_at timestamptz default now();

-- ============================================================
-- 2. Create indexes for efficient dismissal querying
-- ============================================================

create index if not exists idx_connection_quality_dismissed_at
  on public.connection_quality_events(dismissed_at desc nulls first);

create index if not exists idx_connection_quality_unresolved
  on public.connection_quality_events(event_type, dismissed_at)
  where dismissed_at is null;

create index if not exists idx_connection_quality_degradation_unresolved
  on public.connection_quality_events(created_at desc)
  where event_type in ('degradation_detected', 'fallback_triggered')
    and dismissed_at is null;

-- ============================================================
-- 3. Create handle_updated_at trigger function if not exists
-- ============================================================

create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 4. Create trigger to auto-update updated_at on connection_quality_events
-- ============================================================

drop trigger if exists connection_quality_events_updated_at on public.connection_quality_events;

create trigger connection_quality_events_updated_at
  before update on public.connection_quality_events
  for each row
  execute procedure public.handle_updated_at();

-- ============================================================
-- 5. Create dismiss_anomaly() function
--
-- Marks a resolved anomaly event as dismissed.
-- 
-- Parameters:
--   p_event_id: UUID of the connection_quality_events record to dismiss
--   p_resolution_notes: Optional text explaining the resolution/dismissal reason
--
-- Returns:
--   success: boolean indicating if dismissal was successful
--   message: text describing the result
--   dismissed_at: timestamptz when the anomaly was dismissed
--
-- The function:
-- - Validates the event exists and is not already dismissed
-- - Sets dismissed_at to current timestamp
-- - Stores resolution notes if provided
-- - Updates updated_at automatically via trigger
-- - Sends pg_notify to 'connection_quality' channel on success
--
-- Example usage:
--   SELECT * FROM dismiss_anomaly(
--     '123e4567-e89b-12d3-a456-426614174000',
--     'Recovered after network failover'
--   );
-- ============================================================

create or replace function public.dismiss_anomaly(
  p_event_id uuid,
  p_resolution_notes text default null
)
returns table(
  success boolean,
  message text,
  dismissed_at timestamptz,
  event_id uuid
) language plpgsql as $$
declare
  v_event_exists boolean;
  v_already_dismissed boolean;
  v_dismissed_at_value timestamptz;
  v_event_type text;
begin
  -- ============================================================
  -- Step 1: Validate event exists
  -- ============================================================
  select exists(
    select 1 from public.connection_quality_events
    where id = p_event_id
  ) into v_event_exists;

  if not v_event_exists then
    return query select
      false as success,
      format('Event with ID %s not found', p_event_id::text) as message,
      null::timestamptz as dismissed_at,
      p_event_id as event_id;
    return;
  end if;

  -- ============================================================
  -- Step 2: Check if already dismissed
  -- ============================================================
  select dismissed_at is not null into v_already_dismissed
  from public.connection_quality_events
  where id = p_event_id;

  if v_already_dismissed then
    select dismissed_at, event_type into v_dismissed_at_value, v_event_type
    from public.connection_quality_events
    where id = p_event_id;
    
    return query select
      false as success,
      format('Event %s (type: %s) was already dismissed at %s', 
        p_event_id::text, v_event_type, v_dismissed_at_value::text) as message,
      v_dismissed_at_value as dismissed_at,
      p_event_id as event_id;
    return;
  end if;

  -- ============================================================
  -- Step 3: Mark anomaly as dismissed
  -- ============================================================
  v_dismissed_at_value := now();

  update public.connection_quality_events
  set
    dismissed_at = v_dismissed_at_value,
    resolution_notes = coalesce(p_resolution_notes, resolution_notes)
  where id = p_event_id;

  -- ============================================================
  -- Step 4: Send notification to subscribers
  -- ============================================================
  perform pg_notify(
    'connection_quality',
    json_build_object(
      'event', 'anomaly_dismissed',
      'event_id', p_event_id::text,
      'dismissed_at', v_dismissed_at_value::text,
      'resolution_notes', p_resolution_notes
    )::text
  );

  -- ============================================================
  -- Step 5: Return success response
  -- ============================================================
  return query select
    true as success,
    format('Anomaly event %s dismissed successfully', p_event_id::text) as message,
    v_dismissed_at_value as dismissed_at,
    p_event_id as event_id;

end;
$$;

-- ============================================================
-- 6. Create get_unresolved_anomalies() function
--
-- Retrieves all unresolved (not dismissed) anomaly events
-- that require attention or confirmation.
--
-- Returns:
--   All columns from connection_quality_events table where
--   dismissed_at is NULL, ordered by created_at DESC
--
-- Example usage:
--   SELECT * FROM get_unresolved_anomalies();
-- ============================================================

create or replace function public.get_unresolved_anomalies()
returns table(
  id uuid,
  event_type text,
  p95_latency_ms double precision,
  threshold_ms double precision,
  channel_name text,
  fallback_mode text,
  details jsonb,
  created_at timestamptz,
  dismissed_at timestamptz,
  resolution_notes text,
  updated_at timestamptz
) language plpgsql as $$
begin
  return query
  select
    cqe.id,
    cqe.event_type,
    cqe.p95_latency_ms,
    cqe.threshold_ms,
    cqe.channel_name,
    cqe.fallback_mode,
    cqe.details,
    cqe.created_at,
    cqe.dismissed_at,
    cqe.resolution_notes,
    cqe.updated_at
  from public.connection_quality_events cqe
  where cqe.dismissed_at is null
  order by cqe.created_at desc;
end;
$$;

-- ============================================================
-- 7. Create dismiss_resolved_anomalies() function
--
-- Bulk dismisses resolved anomalies based on specific criteria.
-- This function identifies anomalies that have recovered and
-- automatically marks them as resolved.
--
-- Parameters:
--   p_lookback_minutes: How far back to look for recoveries
--                       (default: 30 minutes)
--   p_recovery_threshold: p95 latency threshold below which
--                        anomalies are considered recovered
--                        (default: 100ms)
--
-- Returns:
--   dismissed_count: number of anomalies dismissed
--   message: summary of the operation
--
-- Example usage:
--   SELECT * FROM dismiss_resolved_anomalies(30, 100);
-- ============================================================

create or replace function public.dismiss_resolved_anomalies(
  p_lookback_minutes int default 30,
  p_recovery_threshold double precision default 100
)
returns table(
  dismissed_count int,
  message text
) language plpgsql as $$
declare
  v_dismissed_count int;
  v_lookback_time timestamptz;
begin
  v_lookback_time := now() - (p_lookback_minutes || ' minutes')::interval;

  -- ============================================================
  -- Find and dismiss degradation/fallback events that have recovered
  -- ============================================================
  with events_to_dismiss as (
    select cqe.id
    from public.connection_quality_events cqe
    where cqe.created_at >= v_lookback_time
      and cqe.dismissed_at is null
      and cqe.event_type in ('degradation_detected', 'fallback_triggered')
      and exists (
        select 1
        from public.connection_quality_events cqe2
        where cqe2.created_at > cqe.created_at
          and cqe2.event_type = 'recovery'
          and cqe2.p95_latency_ms <= p_recovery_threshold
          and cqe2.created_at - cqe.created_at < (p_lookback_minutes || ' minutes')::interval
      )
  )
  update public.connection_quality_events cqe
  set dismissed_at = now(),
      resolution_notes = 'Automatically dismissed: anomaly recovered'
  from events_to_dismiss etd
  where cqe.id = etd.id;

  get diagnostics v_dismissed_count = row_count;

  return query select
    v_dismissed_count,
    format('Automatically dismissed %d resolved anomalies', v_dismissed_count) as message;

end;
$$;

-- ============================================================
-- 8. Enable RLS if not already enabled
-- ============================================================

alter table if exists public.connection_quality_events enable row level security;

-- Drop existing policies if they exist
drop policy if exists "anon_select_connection_quality" on public.connection_quality_events;
drop policy if exists "anon_insert_connection_quality" on public.connection_quality_events;
drop policy if exists "anon_update_connection_quality" on public.connection_quality_events;

-- Create new policies
create policy "anon_select_connection_quality"
  on public.connection_quality_events
  for select to anon using (true);

create policy "anon_insert_connection_quality"
  on public.connection_quality_events
  for insert to anon with check (true);

create policy "anon_update_connection_quality"
  on public.connection_quality_events
  for update to anon using (true) with check (true);

-- ============================================================
-- 9. Enable realtime if not already enabled
-- ============================================================

alter publication if exists supabase_realtime add table public.connection_quality_events;
alter table public.connection_quality_events replica identity full;

-- ============================================================
-- 10. Grant function execution permissions
-- ============================================================

grant execute on function public.dismiss_anomaly(uuid, text) to anon;
grant execute on function public.get_unresolved_anomalies() to anon;
grant execute on function public.dismiss_resolved_anomalies(int, double precision) to anon;
