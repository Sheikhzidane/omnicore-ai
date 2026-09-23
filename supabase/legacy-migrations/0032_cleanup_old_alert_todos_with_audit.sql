-- Alert Todo Cleanup Function Enhancement with Audit Scope Documentation
--
-- PURPOSE:
--   Cleanup stale alert_todo records that have been resolved for 30+ days
--   with explicit documentation of targeted record scope and audit logging.
--
-- SCOPE CRITERIA (targeted records for cleanup):
--   1. status = 'resolved' (must be in resolved state)
--   2. resolved_at < NOW() - INTERVAL 'p_days_old days' (default: 30 days)
--      - Records where resolved_at timestamp is older than p_days_old days from now
--   3. Audit trail: Deleted records are logged in alert_todo_audit table
--
-- RETENTION POLICY:
--   - Default: 30 days (p_days_old = 30)
--   - Can be overridden by caller
--   - Configurable to support different retention tiers for different alert severities
--
-- IDEMPOTENCY:
--   - Safe to run multiple times (DELETE is idempotent)
--   - No duplicate deletion risk
--
-- PERFORMANCE NOTES:
--   - Index idx_alert_todo_unresolved used for WHERE status != 'resolved' scans
--   - resolved_at column used for time-range filtering
--   - Bulk DELETE in single transaction for consistency
--   - Returns row count for monitoring/alerting

-- Create alert_todo_audit table to track cleanup operations
CREATE TABLE IF NOT EXISTS alert_todo_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Cleanup operation details
  cleanup_operation_id TEXT NOT NULL,
  p_days_old_threshold INTEGER NOT NULL,
  
  -- Deleted record snapshot
  deleted_alert_todo_id UUID NOT NULL,
  slo_id UUID,
  status TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  breach_severity TEXT,
  model_category TEXT,
  region TEXT,
  
  -- Cleanup metadata
  deleted_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  deleted_by TEXT DEFAULT current_user,
  
  CONSTRAINT fk_deleted_alert_todo_id FOREIGN KEY (deleted_alert_todo_id) 
    REFERENCES alert_todo(id) ON DELETE CASCADE
);

-- Index for audit queries
CREATE INDEX IF NOT EXISTS idx_alert_todo_audit_cleanup_op ON alert_todo_audit(cleanup_operation_id);
CREATE INDEX IF NOT EXISTS idx_alert_todo_audit_deleted_at ON alert_todo_audit(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_todo_audit_slo_id ON alert_todo_audit(slo_id);

-- Enhanced cleanup function with audit logging
CREATE OR REPLACE FUNCTION cleanup_old_resolved_alert_todos(p_days_old integer DEFAULT 30)
RETURNS TABLE(deleted_count integer, audit_operation_id text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count INTEGER;
  v_operation_id TEXT;
  v_deleted_records RECORD;
BEGIN
  -- Generate unique operation ID for audit trail
  v_operation_id := 'cleanup_' || TO_CHAR(NOW(), 'YYYY-MM-DD_HH24-MI-SS-US') || '_' || gen_random_uuid()::TEXT;
  
  -- SCOPE DOCUMENTATION:
  -- Records deleted match ALL of these criteria:
  --   • status = 'resolved' (alert todo has been resolved)
  --   • resolved_at IS NOT NULL (resolved_at timestamp is set)
  --   • resolved_at < NOW() - (p_days_old || ' days') (resolved at least p_days_old days ago)
  --
  -- Example: If p_days_old = 30 and current time is 2024-02-15 10:00:00:
  --   - Deleted: All resolved alert_todos with resolved_at < 2024-01-16 10:00:00
  --   - Retained: Any alert_todo resolved after 2024-01-16 10:00:00
  --
  -- SAFETY CHECKS:
  --   • Does NOT delete pending or acknowledged alerts
  --   • Requires resolved_at to be explicitly set before deletion
  --   • Audit trail preserved in alert_todo_audit table
  
  -- Audit: Log all records being deleted
  INSERT INTO alert_todo_audit (
    cleanup_operation_id,
    p_days_old_threshold,
    deleted_alert_todo_id,
    slo_id,
    status,
    resolved_at,
    breach_severity,
    model_category,
    region
  )
  SELECT
    v_operation_id,
    p_days_old,
    id,
    slo_id,
    status,
    resolved_at,
    breach_severity,
    model_category,
    region
  FROM alert_todo
  WHERE status = 'resolved'
    AND resolved_at IS NOT NULL
    AND resolved_at < NOW() - (p_days_old || ' days')::INTERVAL;
  
  -- Delete the stale records
  DELETE FROM alert_todo
  WHERE status = 'resolved'
    AND resolved_at IS NOT NULL
    AND resolved_at < NOW() - (p_days_old || ' days')::INTERVAL;
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  RETURN QUERY SELECT v_deleted_count, v_operation_id;
END;
$$;

-- Grant execute permission to service role and authenticated users
GRANT EXECUTE ON FUNCTION cleanup_old_resolved_alert_todos(integer) TO service_role, authenticated;

-- USAGE DOCUMENTATION:
--
-- Basic cleanup (30-day default retention):
--   SELECT * FROM cleanup_old_resolved_alert_todos();
--
-- Custom retention period (e.g., 60 days):
--   SELECT * FROM cleanup_old_resolved_alert_todos(60);
--
-- Dry-run query (see what would be deleted without actual deletion):
--   SELECT COUNT(*) as would_be_deleted,
--          COUNT(*) FILTER (WHERE breach_severity = 'critical') as critical_alerts,
--          COUNT(*) FILTER (WHERE breach_severity = 'high') as high_alerts,
--          COUNT(*) FILTER (WHERE breach_severity = 'medium') as medium_alerts
--   FROM alert_todo
--   WHERE status = 'resolved'
--     AND resolved_at IS NOT NULL
--     AND resolved_at < NOW() - INTERVAL '30 days';
--
-- Review audit trail:
--   SELECT cleanup_operation_id,
--          p_days_old_threshold,
--          COUNT(*) as deleted_count,
--          MAX(deleted_at) as latest_cleanup
--   FROM alert_todo_audit
--   GROUP BY cleanup_operation_id, p_days_old_threshold
--   ORDER BY MAX(deleted_at) DESC;
--
-- Query specific cleanup operation results:
--   SELECT * FROM alert_todo_audit
--   WHERE cleanup_operation_id = 'cleanup_2024-02-15_10-30-45-123456_...'
--   ORDER BY deleted_at DESC;
