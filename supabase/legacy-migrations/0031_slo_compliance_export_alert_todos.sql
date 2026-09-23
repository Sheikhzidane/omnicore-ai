-- SLO Compliance Events Export with Threshold Linkage and Idempotent Alert Todo Creation
--
-- This migration creates:
-- 1. alert_todo table with composite unique key (slo_id, breach_window_start) for idempotency
-- 2. Function to export SLO compliance events with threshold metadata
-- 3. Function to upsert alert_todos atomically with deduplication

-- Create alert_todo table for idempotent SLO breach tracking
CREATE TABLE IF NOT EXISTS alert_todo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Composite deduplication key: ensures one todo per SLO per breach window
  slo_id UUID NOT NULL,
  breach_window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- Link to threshold definition
  threshold_id UUID NOT NULL,
  
  -- Link to generated todo item
  todo_id UUID REFERENCES todos(id) ON DELETE SET NULL,
  
  -- SLO context
  model_category TEXT NOT NULL,
  model_name TEXT,
  region TEXT NOT NULL,
  metric_type TEXT NOT NULL,
  
  -- Measurement data from compliance event
  measurement_window_end TIMESTAMP WITH TIME ZONE,
  observed_p95_ms NUMERIC,
  observed_p99_ms NUMERIC,
  p95_slo_met BOOLEAN,
  p99_slo_met BOOLEAN,
  
  -- Breach analysis
  breach_severity TEXT,
  breach_summary TEXT,
  expected_threshold NUMERIC,
  observed_value NUMERIC,
  
  -- Threshold metadata
  threshold_slo_p95_ms INTEGER,
  threshold_slo_p99_ms INTEGER,
  threshold_error_budget_percentage NUMERIC,
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'resolved')),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  
  -- Correlation and metadata
  correlation_id TEXT,
  event_details JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Composite unique key for idempotency
  CONSTRAINT alert_todo_dedup_key UNIQUE (slo_id, breach_window_start)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_alert_todo_slo_id ON alert_todo(slo_id);
CREATE INDEX IF NOT EXISTS idx_alert_todo_threshold_id ON alert_todo(threshold_id);
CREATE INDEX IF NOT EXISTS idx_alert_todo_todo_id ON alert_todo(todo_id) WHERE todo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alert_todo_status ON alert_todo(status);
CREATE INDEX IF NOT EXISTS idx_alert_todo_created ON alert_todo(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_todo_breach_window ON alert_todo(breach_window_start DESC);
CREATE INDEX IF NOT EXISTS idx_alert_todo_unresolved ON alert_todo(status) WHERE status != 'resolved';

-- Function to export SLO compliance event with threshold metadata and create/update alert_todo
-- Uses ON CONFLICT to achieve idempotency on the composite key
CREATE OR REPLACE FUNCTION export_slo_compliance_event_to_alert_todo(
  p_compliance_event_id UUID
)
RETURNS alert_todo
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_compliance_event record;
  v_threshold record;
  v_todo_id UUID;
  v_breach_summary TEXT;
  v_expected_threshold NUMERIC;
  v_observed_value NUMERIC;
  v_breach_severity_final TEXT;
  v_alert_todo alert_todo;
BEGIN
  -- Fetch the SLO compliance event
  SELECT *
  INTO v_compliance_event
  FROM slo_compliance_events
  WHERE id = p_compliance_event_id;
  
  IF v_compliance_event IS NULL THEN
    RAISE EXCEPTION 'SLO compliance event not found: %', p_compliance_event_id;
  END IF;
  
  -- Fetch the linked threshold
  SELECT *
  INTO v_threshold
  FROM slo_thresholds
  WHERE id = v_compliance_event.threshold_id;
  
  IF v_threshold IS NULL THEN
    RAISE EXCEPTION 'SLO threshold not found: %', v_compliance_event.threshold_id;
  END IF;
  
  -- Determine which metric was breached and prepare summary
  IF v_compliance_event.p95_slo_met = false THEN
    v_expected_threshold := v_threshold.slo_p95_ms;
    v_observed_value := v_compliance_event.observed_p95_ms;
    v_breach_summary := FORMAT(
      'P95 latency breach: observed %.0f ms (SLO: %s ms)',
      v_observed_value, v_threshold.slo_p95_ms
    );
  ELSIF v_compliance_event.p99_slo_met = false THEN
    v_expected_threshold := v_threshold.slo_p99_ms;
    v_observed_value := v_compliance_event.observed_p99_ms;
    v_breach_summary := FORMAT(
      'P99 latency breach: observed %.0f ms (SLO: %s ms)',
      v_observed_value, v_threshold.slo_p99_ms
    );
  ELSE
    v_breach_summary := 'SLO compliance check';
  END IF;
  
  -- Determine final breach severity
  v_breach_severity_final := COALESCE(v_compliance_event.breach_severity, 'medium');
  
  -- Upsert alert_todo with idempotency on (slo_id, breach_window_start)
  INSERT INTO alert_todo (
    slo_id,
    breach_window_start,
    threshold_id,
    model_category,
    model_name,
    region,
    metric_type,
    measurement_window_end,
    observed_p95_ms,
    observed_p99_ms,
    p95_slo_met,
    p99_slo_met,
    breach_severity,
    breach_summary,
    expected_threshold,
    observed_value,
    threshold_slo_p95_ms,
    threshold_slo_p99_ms,
    threshold_error_budget_percentage,
    correlation_id,
    event_details,
    status
  )
  VALUES (
    v_compliance_event.baseline_id,  -- slo_id
    v_compliance_event.measurement_window_start,  -- breach_window_start
    v_compliance_event.threshold_id,
    v_compliance_event.model_category,
    v_compliance_event.model_name,
    v_compliance_event.region,
    v_compliance_event.metric_type,
    v_compliance_event.measurement_window_end,
    v_compliance_event.observed_p95_ms,
    v_compliance_event.observed_p99_ms,
    v_compliance_event.p95_slo_met,
    v_compliance_event.p99_slo_met,
    v_breach_severity_final,
    v_breach_summary,
    v_expected_threshold,
    v_observed_value,
    v_threshold.slo_p95_ms,
    v_threshold.slo_p99_ms,
    v_threshold.error_budget_percentage,
    v_compliance_event.event_details->>'correlation_id',
    v_compliance_event.event_details,
    'pending'
  )
  ON CONFLICT (slo_id, breach_window_start)
  DO UPDATE SET
    measurement_window_end = EXCLUDED.measurement_window_end,
    observed_p95_ms = EXCLUDED.observed_p95_ms,
    observed_p99_ms = EXCLUDED.observed_p99_ms,
    p95_slo_met = EXCLUDED.p95_slo_met,
    p99_slo_met = EXCLUDED.p99_slo_met,
    breach_severity = EXCLUDED.breach_severity,
    breach_summary = EXCLUDED.breach_summary,
    expected_threshold = EXCLUDED.expected_threshold,
    observed_value = EXCLUDED.observed_value,
    updated_at = now()
  RETURNING *
  INTO v_alert_todo;
  
  -- If todo doesn't exist yet and breach detected, create one
  IF v_alert_todo.todo_id IS NULL 
     AND (v_alert_todo.p95_slo_met = false OR v_alert_todo.p99_slo_met = false) THEN
    
    INSERT INTO todos (
      title,
      status,
      priority,
      description,
      task_category,
      metadata
    )
    VALUES (
      FORMAT('[SLO Breach] %s - %s (%s)', 
        v_compliance_event.model_category,
        v_compliance_event.metric_type,
        v_compliance_event.region
      ),
      'pending',
      CASE 
        WHEN v_breach_severity_final = 'critical' THEN 'critical'
        WHEN v_breach_severity_final = 'high' THEN 'high'
        ELSE 'medium'
      END,
      v_breach_summary || COALESCE(', Error Budget: ' || v_threshold.error_budget_percentage || '%', ''),
      'infra',
      jsonb_build_object(
        'slo_event_id', p_compliance_event_id,
        'slo_id', v_compliance_event.baseline_id,
        'threshold_id', v_compliance_event.threshold_id,
        'model_category', v_compliance_event.model_category,
        'metric_type', v_compliance_event.metric_type,
        'region', v_compliance_event.region,
        'breach_severity', v_breach_severity_final,
        'expected_threshold', v_expected_threshold,
        'observed_value', v_observed_value
      )
    )
    RETURNING id INTO v_todo_id;
    
    -- Link the created todo to alert_todo
    UPDATE alert_todo
    SET todo_id = v_todo_id, updated_at = now()
    WHERE id = v_alert_todo.id;
    
    v_alert_todo.todo_id := v_todo_id;
  END IF;
  
  RETURN v_alert_todo;
END;
$$;

-- Function to batch export multiple SLO compliance events
CREATE OR REPLACE FUNCTION export_slo_compliance_events_batch(
  p_event_ids UUID[] DEFAULT NULL,
  p_limit INTEGER DEFAULT 1000
)
RETURNS TABLE (
  alert_todo_id UUID,
  slo_id UUID,
  breach_window_start TIMESTAMP WITH TIME ZONE,
  threshold_id UUID,
  todo_id UUID,
  model_category TEXT,
  metric_type TEXT,
  breach_severity TEXT,
  status TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_event_id UUID;
  v_alert_todo alert_todo;
  v_event_ids UUID[];
BEGIN
  -- Determine which events to export
  IF p_event_ids IS NULL OR array_length(p_event_ids, 1) = 0 THEN
    -- Export all unprocessed compliance events (not yet in alert_todo)
    SELECT ARRAY_AGG(id)
    INTO v_event_ids
    FROM slo_compliance_events sce
    WHERE NOT EXISTS (
      SELECT 1 FROM alert_todo at
      WHERE at.slo_id = sce.baseline_id
      AND at.breach_window_start = sce.measurement_window_start
    )
    LIMIT p_limit;
  ELSE
    v_event_ids := p_event_ids;
  END IF;
  
  -- If no events to process, return early
  IF v_event_ids IS NULL OR array_length(v_event_ids, 1) = 0 THEN
    RETURN;
  END IF;
  
  -- Process each event and yield results
  FOREACH v_event_id IN ARRAY v_event_ids
  LOOP
    v_alert_todo := export_slo_compliance_event_to_alert_todo(v_event_id);
    
    RETURN QUERY
    SELECT
      v_alert_todo.id,
      v_alert_todo.slo_id,
      v_alert_todo.breach_window_start,
      v_alert_todo.threshold_id,
      v_alert_todo.todo_id,
      v_alert_todo.model_category,
      v_alert_todo.metric_type,
      v_alert_todo.breach_severity,
      v_alert_todo.status,
      v_alert_todo.created_at,
      v_alert_todo.updated_at;
  END LOOP;
END;
$$;

-- Function to acknowledge or resolve alert_todos
CREATE OR REPLACE FUNCTION update_alert_todo_status(
  p_alert_todo_id UUID,
  p_new_status TEXT
)
RETURNS alert_todo
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_alert_todo alert_todo;
BEGIN
  IF p_new_status NOT IN ('pending', 'acknowledged', 'resolved') THEN
    RAISE EXCEPTION 'Invalid status: %', p_new_status;
  END IF;
  
  UPDATE alert_todo
  SET
    status = p_new_status,
    acknowledged_at = CASE WHEN p_new_status = 'acknowledged' THEN now() ELSE acknowledged_at END,
    resolved_at = CASE WHEN p_new_status = 'resolved' THEN now() ELSE resolved_at END,
    updated_at = now()
  WHERE id = p_alert_todo_id
  RETURNING *
  INTO v_alert_todo;
  
  IF v_alert_todo IS NULL THEN
    RAISE EXCEPTION 'Alert todo not found: %', p_alert_todo_id;
  END IF;
  
  RETURN v_alert_todo;
END;
$$;

-- Cleanup function to remove acknowledged alert_todos that are too old
CREATE OR REPLACE FUNCTION cleanup_old_resolved_alert_todos(
  p_days_old INTEGER DEFAULT 30
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  DELETE FROM alert_todo
  WHERE status = 'resolved'
  AND resolved_at < now() - (p_days_old || ' days')::INTERVAL;
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$$;

-- Grant execute on public functions
GRANT EXECUTE ON FUNCTION export_slo_compliance_event_to_alert_todo(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION export_slo_compliance_events_batch(UUID[], INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_alert_todo_status(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_resolved_alert_todos(INTEGER) TO anon, authenticated;
