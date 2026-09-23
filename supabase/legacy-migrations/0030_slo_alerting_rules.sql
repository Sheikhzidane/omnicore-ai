-- SLO (Service Level Objective) Alerting Rules System
-- 
-- This migration creates tables and functions for:
-- 1. Defining SLO alert rules with thresholds
-- 2. Detecting breaches and logging them
-- 3. Creating todos when breaches are detected

-- Create alert_rules table to define SLO breach rules
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('latency', 'failure_rate', 'throughput')),
  
  -- Threshold configuration (interpretation depends on rule_type)
  warning_threshold NUMERIC NOT NULL,
  critical_threshold NUMERIC NOT NULL,
  
  -- Window for aggregating metrics
  window_minutes INTEGER DEFAULT 5,
  
  -- Action configuration
  auto_create_todo BOOLEAN DEFAULT true,
  todo_priority TEXT DEFAULT 'high' CHECK (todo_priority IN ('low', 'medium', 'high', 'critical')),
  
  -- Enable/disable the rule
  enabled BOOLEAN DEFAULT true,
  
  -- Cooldown to prevent alert spam (minutes)
  cooldown_minutes INTEGER DEFAULT 30,
  
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_type ON alert_rules(rule_type);

-- Create alert_detections table to log breach events
CREATE TABLE IF NOT EXISTS alert_detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  
  detection_type TEXT NOT NULL CHECK (detection_type IN ('warning', 'critical')),
  
  -- Metric data captured at detection time
  metric_name TEXT NOT NULL,
  metric_value NUMERIC NOT NULL,
  threshold_value NUMERIC NOT NULL,
  
  -- Context
  window_start TIMESTAMP WITH TIME ZONE,
  window_end TIMESTAMP WITH TIME ZONE,
  
  -- Related todo if auto-created
  created_todo_id UUID REFERENCES todos(id) ON DELETE SET NULL,
  
  -- Whether alert was acknowledged/resolved
  acknowledged BOOLEAN DEFAULT false,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP WITH TIME ZONE,
  
  correlation_id TEXT,
  metadata JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_detections_rule ON alert_detections(alert_rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_detections_unresolved ON alert_detections(resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_alert_detections_created ON alert_detections(created_at DESC);

-- Create slo_baseline table to track SLO thresholds over time
CREATE TABLE IF NOT EXISTS slo_baseline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  
  -- Percentile metrics
  p50_ms NUMERIC,
  p95_ms NUMERIC,
  p99_ms NUMERIC,
  
  -- Computed thresholds
  acceptable_threshold_ms NUMERIC,
  warning_threshold_ms NUMERIC,
  critical_threshold_ms NUMERIC,
  
  -- Context
  sample_count INTEGER,
  sample_period_hours INTEGER DEFAULT 24,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slo_baseline_rule ON slo_baseline(alert_rule_id);

-- Function to create a todo from an alert detection
CREATE OR REPLACE FUNCTION create_alert_todo(
  p_alert_rule_id UUID,
  p_detection_type TEXT,
  p_metric_name TEXT,
  p_metric_value NUMERIC,
  p_threshold_value NUMERIC,
  p_priority TEXT DEFAULT 'high'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_todo_id UUID;
  v_rule_name TEXT;
  v_title TEXT;
  v_description TEXT;
BEGIN
  -- Get the alert rule name
  SELECT name INTO v_rule_name FROM alert_rules WHERE id = p_alert_rule_id;
  
  IF v_rule_name IS NULL THEN
    RAISE EXCEPTION 'Alert rule not found: %', p_alert_rule_id;
  END IF;
  
  -- Build todo title and description
  v_title := FORMAT('[SLO Alert] %s - %s Threshold Breach', v_rule_name, UPPER(p_detection_type));
  v_description := FORMAT(
    'SLO breach detected for rule "%s". Metric: %s, Current: %.2f, Threshold: %.2f',
    v_rule_name, p_metric_name, p_metric_value, p_threshold_value
  );
  
  -- Insert todo
  INSERT INTO todos (
    title,
    status,
    priority,
    description,
    task_category,
    metadata
  )
  VALUES (
    v_title,
    'pending',
    p_priority,
    v_description,
    'infra',
    jsonb_build_object(
      'alert_rule_id', p_alert_rule_id,
      'metric_name', p_metric_name,
      'metric_value', p_metric_value,
      'threshold_value', p_threshold_value,
      'detection_type', p_detection_type
    )
  )
  RETURNING id INTO v_todo_id;
  
  RETURN v_todo_id;
END;
$$;

-- Function to record an SLO breach and optionally create a todo
CREATE OR REPLACE FUNCTION log_slo_breach(
  p_alert_rule_id UUID,
  p_detection_type TEXT,
  p_metric_name TEXT,
  p_metric_value NUMERIC,
  p_threshold_value NUMERIC,
  p_window_start TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  p_window_end TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  p_correlation_id TEXT DEFAULT NULL,
  p_auto_create_todo BOOLEAN DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_detection_id UUID;
  v_todo_id UUID := NULL;
  v_auto_create_todo BOOLEAN;
  v_priority TEXT;
BEGIN
  -- Get rule config
  SELECT auto_create_todo, todo_priority
  INTO v_auto_create_todo, v_priority
  FROM alert_rules
  WHERE id = p_alert_rule_id;
  
  IF v_auto_create_todo IS NULL THEN
    RAISE EXCEPTION 'Alert rule not found: %', p_alert_rule_id;
  END IF;
  
  -- Override with parameter if provided
  IF p_auto_create_todo IS NOT NULL THEN
    v_auto_create_todo := p_auto_create_todo;
  END IF;
  
  -- Create todo if enabled
  IF v_auto_create_todo THEN
    v_todo_id := create_alert_todo(
      p_alert_rule_id,
      p_detection_type,
      p_metric_name,
      p_metric_value,
      p_threshold_value,
      v_priority
    );
  END IF;
  
  -- Log the detection
  INSERT INTO alert_detections (
    alert_rule_id,
    detection_type,
    metric_name,
    metric_value,
    threshold_value,
    window_start,
    window_end,
    created_todo_id,
    correlation_id
  )
  VALUES (
    p_alert_rule_id,
    p_detection_type,
    p_metric_name,
    p_metric_value,
    p_threshold_value,
    COALESCE(p_window_start, now()),
    COALESCE(p_window_end, now()),
    v_todo_id,
    p_correlation_id
  )
  RETURNING id INTO v_detection_id;
  
  RETURN v_detection_id;
END;
$$;

-- Function to check and apply SLO rules for SQL execution latency
CREATE OR REPLACE FUNCTION check_sql_latency_slos()
RETURNS TABLE(
  detection_id UUID,
  rule_name TEXT,
  breach_type TEXT,
  metric_value NUMERIC,
  threshold_value NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rule record;
  v_window_start TIMESTAMP WITH TIME ZONE;
  v_metrics record;
  v_detection_id UUID;
BEGIN
  -- Iterate through enabled latency rules
  FOR v_rule IN 
    SELECT id, name, warning_threshold, critical_threshold, window_minutes, cooldown_minutes
    FROM alert_rules
    WHERE enabled = true
    AND rule_type = 'latency'
  LOOP
    -- Define window
    v_window_start := now() - (v_rule.window_minutes || ' minutes')::INTERVAL;
    
    -- Check for critical breaches
    FOR v_metrics IN
      SELECT
        execution_time_ms,
        created_at,
        correlation_id
      FROM agent_sql_execution_log
      WHERE execution_status = 'success'
      AND execution_time_ms > v_rule.critical_threshold
      AND created_at > v_window_start
      AND NOT EXISTS (
        SELECT 1 FROM alert_detections ad
        WHERE ad.alert_rule_id = v_rule.id
        AND ad.detection_type = 'critical'
        AND ad.created_at > now() - (v_rule.cooldown_minutes || ' minutes')::INTERVAL
        AND ad.resolved = false
      )
      ORDER BY execution_time_ms DESC
      LIMIT 1
    LOOP
      v_detection_id := log_slo_breach(
        v_rule.id,
        'critical',
        'execution_time_ms',
        v_metrics.execution_time_ms,
        v_rule.critical_threshold,
        v_window_start,
        now(),
        v_metrics.correlation_id
      );
      
      RETURN QUERY SELECT
        v_detection_id,
        v_rule.name,
        'critical',
        v_metrics.execution_time_ms::NUMERIC,
        v_rule.critical_threshold::NUMERIC;
    END LOOP;
    
    -- Check for warning breaches
    FOR v_metrics IN
      SELECT
        execution_time_ms,
        created_at,
        correlation_id
      FROM agent_sql_execution_log
      WHERE execution_status = 'success'
      AND execution_time_ms > v_rule.warning_threshold
      AND execution_time_ms <= v_rule.critical_threshold
      AND created_at > v_window_start
      AND NOT EXISTS (
        SELECT 1 FROM alert_detections ad
        WHERE ad.alert_rule_id = v_rule.id
        AND ad.detection_type = 'warning'
        AND ad.created_at > now() - (v_rule.cooldown_minutes || ' minutes')::INTERVAL
        AND ad.resolved = false
      )
      ORDER BY execution_time_ms DESC
      LIMIT 1
    LOOP
      v_detection_id := log_slo_breach(
        v_rule.id,
        'warning',
        'execution_time_ms',
        v_metrics.execution_time_ms,
        v_rule.warning_threshold,
        v_window_start,
        now(),
        v_metrics.correlation_id
      );
      
      RETURN QUERY SELECT
        v_detection_id,
        v_rule.name,
        'warning',
        v_metrics.execution_time_ms::NUMERIC,
        v_rule.warning_threshold::NUMERIC;
    END LOOP;
  END LOOP;
END;
$$;

-- Function to mark a detection as resolved
CREATE OR REPLACE FUNCTION resolve_alert_detection(
  p_detection_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE alert_detections
  SET
    resolved = true,
    resolved_at = now(),
    updated_at = now()
  WHERE id = p_detection_id;
END;
$$;

-- Function to get active/recent alerts
CREATE OR REPLACE FUNCTION get_active_alerts(
  p_hours_back INTEGER DEFAULT 24
)
RETURNS TABLE(
  detection_id UUID,
  rule_name TEXT,
  rule_type TEXT,
  detection_type TEXT,
  metric_value NUMERIC,
  threshold_value NUMERIC,
  created_todo_id UUID,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ad.id,
    ar.name,
    ar.rule_type,
    ad.detection_type,
    ad.metric_value,
    ad.threshold_value,
    ad.created_todo_id,
    ad.created_at
  FROM alert_detections ad
  JOIN alert_rules ar ON ad.alert_rule_id = ar.id
  WHERE ad.created_at > now() - (p_hours_back || ' hours')::INTERVAL
  ORDER BY ad.created_at DESC;
END;
$$;

-- Seed some default SLO alert rules
INSERT INTO alert_rules (
  name,
  description,
  rule_type,
  warning_threshold,
  critical_threshold,
  window_minutes,
  auto_create_todo,
  todo_priority,
  enabled
) VALUES
  (
    'SQL Query Latency - High',
    'Alerts when SQL queries exceed latency SLO thresholds',
    'latency',
    500,   -- warning at 500ms
    1000,  -- critical at 1000ms
    5,
    true,
    'high',
    true
  ),
  (
    'SQL Query Latency - Critical',
    'Aggressive SLO for critical operations',
    'latency',
    250,   -- warning at 250ms
    500,   -- critical at 500ms
    5,
    true,
    'critical',
    false  -- disabled by default, enable when needed
  )
ON CONFLICT (name) DO NOTHING;

-- Create index for efficient alert rule lookups
CREATE INDEX IF NOT EXISTS idx_alert_rules_active ON alert_rules(enabled, rule_type);
