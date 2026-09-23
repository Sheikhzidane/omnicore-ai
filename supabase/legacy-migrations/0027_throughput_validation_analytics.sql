/**
 * Migration: 0027_throughput_validation_analytics.sql
 * 
 * Adds SQL functions for validating throughput improvement post-dismissal.
 * Provides analytics to measure if dismissing anomalies correlates with
 * improved task completion rates.
 */

-- ============================================================================
-- Function: get_throughput_baseline_window
-- 
-- Retrieves throughput metrics for a specific time window, anchored to
-- a reference time (either before or after dismissal).
-- ============================================================================
CREATE OR REPLACE FUNCTION get_throughput_baseline_window(
  p_reference_time TIMESTAMP WITH TIME ZONE,
  p_window_minutes INTEGER,
  p_lookback BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  start_time TIMESTAMP WITH TIME ZONE,
  end_time TIMESTAMP WITH TIME ZONE,
  duration_minutes INTEGER,
  completion_count BIGINT,
  completion_rate DOUBLE PRECISION,
  anomaly_detected BOOLEAN
) AS $$
DECLARE
  v_start_time TIMESTAMP WITH TIME ZONE;
  v_end_time TIMESTAMP WITH TIME ZONE;
BEGIN
  -- If lookback=TRUE, measure p_window_minutes BEFORE reference_time
  -- If lookback=FALSE, measure p_window_minutes AFTER reference_time
  IF p_lookback THEN
    v_end_time := p_reference_time;
    v_start_time := p_reference_time - (p_window_minutes || ' minutes')::INTERVAL;
  ELSE
    v_start_time := p_reference_time;
    v_end_time := p_reference_time + (p_window_minutes || ' minutes')::INTERVAL;
  END IF;

  RETURN QUERY
  SELECT
    v_start_time,
    v_end_time,
    p_window_minutes,
    (
      SELECT COUNT(*)::BIGINT
      FROM task_history
      WHERE action = 'completed'
        AND changed_at >= v_start_time
        AND changed_at < v_end_time
    ),
    (
      SELECT CASE
        WHEN total = 0 THEN 0
        ELSE (completed::DOUBLE PRECISION / total)
      END
      FROM (
        SELECT
          COUNT(CASE WHEN action = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN action IN ('completed', 'created') THEN 1 END) as total
        FROM task_history
        WHERE changed_at >= v_start_time
          AND changed_at < v_end_time
      ) t
    ),
    (
      SELECT COUNT(*) > 0
      FROM task_throughput_events
      WHERE detected_at >= v_start_time
        AND detected_at < v_end_time
        AND anomaly_detected = TRUE
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Function: calculate_dismissal_impact
-- 
-- For a specific dismissal event, calculates pre/post throughput metrics
-- and determines if there was an improvement.
-- ============================================================================
CREATE OR REPLACE FUNCTION calculate_dismissal_impact(
  p_dismissal_id UUID,
  p_pre_window_minutes INTEGER DEFAULT 60,
  p_post_window_minutes INTEGER DEFAULT 60
)
RETURNS TABLE (
  dismissal_id UUID,
  dismissed_at TIMESTAMP WITH TIME ZONE,
  pre_completion_count BIGINT,
  pre_completion_rate DOUBLE PRECISION,
  post_completion_count BIGINT,
  post_completion_rate DOUBLE PRECISION,
  completion_count_delta BIGINT,
  completion_rate_delta DOUBLE PRECISION,
  completion_rate_pct_improvement DOUBLE PRECISION,
  is_improvement BOOLEAN
) AS $$
DECLARE
  v_dismissed_at TIMESTAMP WITH TIME ZONE;
  v_pre_count BIGINT;
  v_pre_rate DOUBLE PRECISION;
  v_post_count BIGINT;
  v_post_rate DOUBLE PRECISION;
BEGIN
  -- Get the dismissal timestamp
  SELECT dismissed_at INTO v_dismissed_at
  FROM task_throughput_events
  WHERE id = p_dismissal_id
  AND dismissed_at IS NOT NULL;
  
  IF v_dismissed_at IS NULL THEN
    RETURN;
  END IF;

  -- Get pre-dismissal metrics
  SELECT completion_count, completion_rate
  INTO v_pre_count, v_pre_rate
  FROM get_throughput_baseline_window(v_dismissed_at, p_pre_window_minutes, TRUE);

  -- Get post-dismissal metrics
  SELECT completion_count, completion_rate
  INTO v_post_count, v_post_rate
  FROM get_throughput_baseline_window(v_dismissed_at, p_post_window_minutes, FALSE);

  RETURN QUERY
  SELECT
    p_dismissal_id,
    v_dismissed_at,
    v_pre_count,
    v_pre_rate,
    v_post_count,
    v_post_rate,
    (v_post_count - v_pre_count),
    (v_post_rate - v_pre_rate),
    CASE
      WHEN v_pre_rate = 0 THEN 0
      ELSE ((v_post_rate - v_pre_rate) / v_pre_rate) * 100
    END,
    (v_post_rate > v_pre_rate);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Function: validate_throughput_improvement
-- 
-- Comprehensive analysis of dismissal effectiveness across all dismissals
-- in a time period. Returns aggregated metrics and statistical analysis.
-- ============================================================================
CREATE OR REPLACE FUNCTION validate_throughput_improvement(
  p_analysis_days INTEGER DEFAULT 7,
  p_pre_window_minutes INTEGER DEFAULT 60,
  p_post_window_minutes INTEGER DEFAULT 60,
  p_improvement_threshold_pct DOUBLE PRECISION DEFAULT 5.0
)
RETURNS TABLE (
  analysis_period_start TIMESTAMP WITH TIME ZONE,
  analysis_period_end TIMESTAMP WITH TIME ZONE,
  total_dismissals_analyzed BIGINT,
  dismissals_with_improvement BIGINT,
  dismissals_without_improvement BIGINT,
  improvement_rate DOUBLE PRECISION,
  average_completion_rate_improvement DOUBLE PRECISION,
  median_completion_rate_improvement DOUBLE PRECISION,
  std_dev_improvement DOUBLE PRECISION,
  min_improvement DOUBLE PRECISION,
  max_improvement DOUBLE PRECISION,
  data_quality_notes TEXT
) AS $$
DECLARE
  v_period_start TIMESTAMP WITH TIME ZONE;
  v_period_end TIMESTAMP WITH TIME ZONE;
  v_total_dismissals BIGINT;
  v_improvements_count BIGINT;
  v_avg_improvement DOUBLE PRECISION;
  v_median_improvement DOUBLE PRECISION;
  v_stdev_improvement DOUBLE PRECISION;
  v_min_improvement DOUBLE PRECISION;
  v_max_improvement DOUBLE PRECISION;
BEGIN
  v_period_end := NOW();
  v_period_start := v_period_end - (p_analysis_days || ' days')::INTERVAL;

  -- Collect all dismissals and their impacts
  WITH dismissals_with_impact AS (
    SELECT
      tte.id,
      tte.dismissed_at,
      impact.completion_rate_delta,
      CASE WHEN impact.post_completion_rate > impact.pre_completion_rate THEN 1 ELSE 0 END as improved
    FROM task_throughput_events tte
    CROSS JOIN LATERAL calculate_dismissal_impact(tte.id, p_pre_window_minutes, p_post_window_minutes) impact
    WHERE tte.dismissed_at IS NOT NULL
      AND tte.dismissed_at >= v_period_start
      AND tte.dismissed_at < v_period_end
  )
  SELECT
    COUNT(*),
    SUM(improved),
    AVG(completion_rate_delta),
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY completion_rate_delta),
    STDDEV_POP(completion_rate_delta),
    MIN(completion_rate_delta),
    MAX(completion_rate_delta)
  INTO
    v_total_dismissals,
    v_improvements_count,
    v_avg_improvement,
    v_median_improvement,
    v_stdev_improvement,
    v_min_improvement,
    v_max_improvement
  FROM dismissals_with_impact;

  -- Return results
  RETURN QUERY
  SELECT
    v_period_start,
    v_period_end,
    COALESCE(v_total_dismissals, 0),
    COALESCE(v_improvements_count, 0),
    COALESCE(v_total_dismissals - v_improvements_count, 0),
    CASE
      WHEN v_total_dismissals > 0 THEN (v_improvements_count::DOUBLE PRECISION / v_total_dismissals) * 100
      ELSE NULL
    END,
    v_avg_improvement,
    v_median_improvement,
    v_stdev_improvement,
    v_min_improvement,
    v_max_improvement,
    'Analysis based on ' || COALESCE(v_total_dismissals::TEXT, '0') || ' dismissals over ' || p_analysis_days || ' days';
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- View: throughput_dismissal_impact_summary
-- 
-- Quick view showing the impact of each dismissal on throughput metrics.
-- ============================================================================
CREATE OR REPLACE VIEW throughput_dismissal_impact_summary AS
SELECT
  tte.id,
  tte.detected_at,
  tte.dismissed_at,
  tte.completion_rate as anomaly_completion_rate,
  tte.anomaly_reason,
  impact.pre_completion_rate,
  impact.post_completion_rate,
  impact.completion_rate_delta,
  impact.is_improvement,
  ROUND(impact.completion_rate_pct_improvement::NUMERIC, 2)::DOUBLE PRECISION as pct_improvement
FROM task_throughput_events tte
CROSS JOIN LATERAL calculate_dismissal_impact(tte.id, 60, 60) impact
WHERE tte.dismissed_at IS NOT NULL
ORDER BY tte.dismissed_at DESC;

-- ============================================================================
-- Indexes for performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_task_history_action_changed_at
  ON task_history(action, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_throughput_events_dismissed_at
  ON task_throughput_events(dismissed_at DESC)
  WHERE dismissed_at IS NOT NULL;

COMMIT;
