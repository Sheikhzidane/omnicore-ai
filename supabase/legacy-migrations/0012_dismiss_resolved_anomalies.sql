-- ============================================================
-- Connection Quality Events - Dismiss Resolved Anomalies
-- Adds resolved_at column and function to dismiss resolved anomalies
-- ============================================================

-- ============================================================
-- 1. Add resolved_at column to connection_quality_events
-- ============================================================

alter table if exists public.connection_quality_events
add column if not exists resolved_at timestamptz;

-- ============================================================
-- 2. Create indexes for resolved_at querying
-- ============================================================

create index if not exists idx_connection_quality_resolved_at
  on public.connection_quality_events(resolved_at desc nulls last);

create index if not exists idx_connection_quality_resolved_unresolved
  on public.connection_quality_events(resolved_at, dismissed_at)
  where resolved_at is not null and dismissed_at is null;

-- ============================================================
-- 3. Create dismiss_resolved_anomalies_batch() function
--
-- Bulk dismisses all resolved anomalies (where resolved_at IS NOT NULL)
-- that have not yet been dismissed.
--
-- This function:
-- - Finds all events where resolved_at IS NOT NULL and dismissed_at IS NULL
-- - Calls dismiss_anomaly() for each event
-- - Returns summary of dismissed anomalies
--
-- Returns:
--   total_resolved: Count of anomalies with resolved_at IS NOT NULL
--   total_dismissed: Count of anomalies successfully dismissed in this call
--   message: Summary message
--
-- Example usage:
--   SELECT * FROM dismiss_resolved_anomalies_batch();
-- ============================================================

create or replace function public.dismiss_resolved_anomalies_batch()
returns table(
  total_resolved bigint,
  total_dismissed bigint,
  message text
) language plpgsql as $$
declare
  v_event_id uuid;
  v_dismissed_count bigint := 0;
  v_resolved_count bigint;
  v_result record;
begin
  -- Get count of resolved but not dismissed anomalies
  select count(*) into v_resolved_count
  from public.connection_quality_events
  where resolved_at is not null
    and dismissed_at is null;

  -- Process each resolved anomaly
  for v_event_id in
    select id from public.connection_quality_events
    where resolved_at is not null
      and dismissed_at is null
    order by resolved_at asc
  loop
    -- Call dismiss_anomaly for each event
    perform dismiss_anomaly(v_event_id, 'Auto-dismissed: anomaly resolved');
    v_dismissed_count := v_dismissed_count + 1;
  end loop;

  -- Return summary
  return query select
    v_resolved_count as total_resolved,
    v_dismissed_count as total_dismissed,
    format('Dismissed %s of %s resolved anomalies', 
      v_dismissed_count, v_resolved_count) as message;

end;
$$;

-- ============================================================
-- 4. Create dismiss_resolved_anomaly() function
--
-- Dismisses a specific resolved anomaly event.
-- This is a convenience function that combines resolving and dismissing.
--
-- Parameters:
--   p_event_id: UUID of the connection_quality_events record
--   p_resolved_at: Timestamp when the anomaly was resolved (default: now())
--   p_resolution_notes: Optional text explaining the resolution
--
-- Returns:
--   success: boolean indicating if the operation was successful
--   message: text describing the result
--   dismissed_at: timestamptz when the anomaly was dismissed
--   event_id: UUID of the processed event
--
-- Example usage:
--   SELECT * FROM dismiss_resolved_anomaly(
--     '123e4567-e89b-12d3-a456-426614174000',
--     now(),
--     'Connection recovered after failover'
--   );
-- ============================================================

create or replace function public.dismiss_resolved_anomaly(
  p_event_id uuid,
  p_resolved_at timestamptz default now(),
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
  v_event_resolved boolean;
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
  -- Step 2: Mark event as resolved and dismiss
  -- ============================================================
  update public.connection_quality_events
  set resolved_at = p_resolved_at
  where id = p_event_id and resolved_at is null;

  -- ============================================================
  -- Step 3: Call dismiss_anomaly to mark as dismissed
  -- ============================================================
  return query
  select * from dismiss_anomaly(p_event_id, p_resolution_notes);

end;
$$;
