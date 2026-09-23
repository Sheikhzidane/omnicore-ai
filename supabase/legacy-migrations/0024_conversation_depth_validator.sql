-- ============================================================================
-- Conversation-Depth Confidence Validator
-- Injects checkpoints after DB queries to track success/failure patterns
-- ============================================================================

-- Add checkpoints JSONB column to god_status
ALTER TABLE public.god_status
ADD COLUMN IF NOT EXISTS checkpoints jsonb DEFAULT '[]'::jsonb;

-- Add confidence_score column to track conversation depth quality
ALTER TABLE public.god_status
ADD COLUMN IF NOT EXISTS confidence_score numeric DEFAULT 0.0;

-- Add last_checkpoint_at timestamp to track freshness
ALTER TABLE public.god_status
ADD COLUMN IF NOT EXISTS last_checkpoint_at timestamptz DEFAULT NULL;

-- Index for checkpoint queries
CREATE INDEX IF NOT EXISTS idx_god_status_last_checkpoint_at
ON public.god_status(last_checkpoint_at DESC);

-- ============================================================================
-- Query Checkpoint Type
-- ============================================================================
-- Each checkpoint captures:
--   - query_type: 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DDL', 'RPC'
--   - query_hash: MD5 hash of sanitized query for deduplication
--   - status: 'success' | 'error' | 'timeout' | 'validation_failed'
--   - error_code: SQLSTATE or custom code if applicable
--   - error_message: Human-readable error details
--   - row_count: Rows returned (for SELECT) or affected (for DML)
--   - execution_ms: Query runtime in milliseconds
--   - executed_at: Timestamp of execution
--   - table_accessed: Extracted table names from the query
--   - tags: Array of semantic tags (e.g. ['conversation_state', 'task_meta'])

-- ============================================================================
-- RPC: log_query_checkpoint - Append checkpoint to god_status
-- ============================================================================
CREATE OR REPLACE FUNCTION log_query_checkpoint(
  p_query_type text,
  p_query_hash text,
  p_status text,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_row_count integer DEFAULT 0,
  p_execution_ms numeric DEFAULT 0,
  p_tables_accessed text[] DEFAULT ARRAY[]::text[],
  p_tags text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checkpoint jsonb;
  v_updated_checkpoints jsonb;
  v_success_count integer;
  v_error_count integer;
  v_confidence_score numeric;
BEGIN
  -- Build checkpoint object
  v_checkpoint := jsonb_build_object(
    'query_type', p_query_type,
    'query_hash', p_query_hash,
    'status', p_status,
    'error_code', p_error_code,
    'error_message', p_error_message,
    'row_count', p_row_count,
    'execution_ms', p_execution_ms,
    'tables_accessed', p_tables_accessed,
    'tags', p_tags,
    'executed_at', now()::text
  );

  -- Append checkpoint to array (keep only last 1000)
  v_updated_checkpoints := (
    SELECT jsonb_agg(elem ORDER BY executed_at DESC)
    FROM (
      SELECT * FROM jsonb_array_elements(
        (SELECT COALESCE(checkpoints, '[]'::jsonb) FROM god_status WHERE id = 1)
      ) AS elem
      UNION ALL
      SELECT v_checkpoint
    ) sub(elem, executed_at)
    LIMIT 1000
  );

  -- Calculate confidence score from recent checkpoints
  -- Success ratio × conversation coherence factor
  SELECT 
    COUNT(*) FILTER (WHERE elem->>'status' = 'success')::numeric INTO v_success_count
  FROM jsonb_array_elements(v_updated_checkpoints) AS elem;
  
  SELECT 
    COUNT(*) FILTER (WHERE elem->>'status' = 'error')::numeric INTO v_error_count
  FROM jsonb_array_elements(v_updated_checkpoints) AS elem;

  v_confidence_score := CASE 
    WHEN (v_success_count + v_error_count) = 0 THEN 0.0
    ELSE (v_success_count::numeric / (v_success_count + v_error_count)) * 100
  END;

  -- Update god_status with checkpoint and confidence
  UPDATE public.god_status
  SET 
    checkpoints = v_updated_checkpoints,
    confidence_score = v_confidence_score,
    last_checkpoint_at = now()
  WHERE id = 1;

  -- Return checkpoint summary
  RETURN jsonb_build_object(
    'checkpoint_added', v_checkpoint,
    'total_checkpoints', jsonb_array_length(v_updated_checkpoints),
    'confidence_score', v_confidence_score,
    'success_count', v_success_count,
    'error_count', v_error_count
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_query_checkpoint(text, text, text, text, text, integer, numeric, text[], text[]) 
  TO service_role, authenticated, anon;

-- ============================================================================
-- RPC: get_conversation_depth_metrics - Analyze checkpoint history
-- ============================================================================
CREATE OR REPLACE FUNCTION get_conversation_depth_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checkpoints jsonb;
  v_total_count integer;
  v_success_count integer;
  v_error_count integer;
  v_query_types jsonb;
  v_error_distribution jsonb;
  v_tables_accessed jsonb;
  v_tags_distribution jsonb;
  v_avg_execution_ms numeric;
  v_confidence_score numeric;
  v_last_checkpoint_at timestamptz;
BEGIN
  -- Fetch current state
  SELECT checkpoints, confidence_score, last_checkpoint_at
  INTO v_checkpoints, v_confidence_score, v_last_checkpoint_at
  FROM public.god_status
  WHERE id = 1;

  v_checkpoints := COALESCE(v_checkpoints, '[]'::jsonb);

  -- Total checkpoints
  SELECT jsonb_array_length(v_checkpoints) INTO v_total_count;

  -- Success/error counts
  SELECT COUNT(*) FILTER (WHERE elem->>'status' = 'success')
  INTO v_success_count
  FROM jsonb_array_elements(v_checkpoints) AS elem;

  SELECT COUNT(*) FILTER (WHERE elem->>'status' = 'error')
  INTO v_error_count
  FROM jsonb_array_elements(v_checkpoints) AS elem;

  -- Query type distribution
  SELECT jsonb_object_agg(
    elem->>'query_type',
    COUNT(*)::text
  )
  INTO v_query_types
  FROM jsonb_array_elements(v_checkpoints) AS elem
  GROUP BY elem->>'query_type';

  -- Error code distribution
  SELECT jsonb_object_agg(
    COALESCE(elem->>'error_code', 'NO_ERROR'),
    COUNT(*)::text
  )
  INTO v_error_distribution
  FROM jsonb_array_elements(v_checkpoints) AS elem
  WHERE elem->>'status' = 'error'
  GROUP BY COALESCE(elem->>'error_code', 'NO_ERROR');

  -- Unique tables accessed
  SELECT jsonb_agg(DISTINCT elem)
  INTO v_tables_accessed
  FROM jsonb_array_elements(v_checkpoints) AS elem_obj,
       jsonb_array_elements(elem_obj->'tables_accessed') AS elem;

  -- Tag distribution
  SELECT jsonb_object_agg(tag, COUNT(*)::text)
  INTO v_tags_distribution
  FROM jsonb_array_elements(v_checkpoints) AS elem,
       jsonb_array_elements(elem->'tags') AS tag
  GROUP BY tag;

  -- Average execution time
  SELECT AVG((elem->>'execution_ms')::numeric)
  INTO v_avg_execution_ms
  FROM jsonb_array_elements(v_checkpoints) AS elem;

  -- Return comprehensive metrics
  RETURN jsonb_build_object(
    'total_checkpoints', v_total_count,
    'success_count', v_success_count,
    'error_count', v_error_count,
    'success_rate_percent', CASE 
      WHEN (v_success_count + v_error_count) = 0 THEN 0.0
      ELSE ROUND((v_success_count::numeric / (v_success_count + v_error_count)) * 100, 2)
    END,
    'confidence_score', v_confidence_score,
    'query_type_distribution', COALESCE(v_query_types, '{}'::jsonb),
    'error_code_distribution', COALESCE(v_error_distribution, '{}'::jsonb),
    'tables_accessed', COALESCE(v_tables_accessed, '[]'::jsonb),
    'tags_distribution', COALESCE(v_tags_distribution, '{}'::jsonb),
    'avg_execution_ms', ROUND(COALESCE(v_avg_execution_ms, 0)::numeric, 2),
    'last_checkpoint_at', v_last_checkpoint_at,
    'freshness_seconds', EXTRACT(EPOCH FROM (now() - v_last_checkpoint_at))::integer
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_conversation_depth_metrics()
  TO service_role, authenticated, anon;

-- ============================================================================
-- RPC: reset_conversation_checkpoints - Clear checkpoint history
-- ============================================================================
CREATE OR REPLACE FUNCTION reset_conversation_checkpoints()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.god_status
  SET 
    checkpoints = '[]'::jsonb,
    confidence_score = 0.0,
    last_checkpoint_at = NULL
  WHERE id = 1;
  
  RETURN 'Checkpoints reset successfully';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERROR: ' || SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_conversation_checkpoints()
  TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN god_status.checkpoints IS 
  'JSONB array of query execution checkpoints, each containing: query_type, query_hash, status, error details, execution time, tables accessed, and semantic tags. Limited to last 1000 entries.';

COMMENT ON COLUMN god_status.confidence_score IS 
  'Numeric score (0-100) representing success rate of recent query checkpoints. Updated with each new checkpoint.';

COMMENT ON COLUMN god_status.last_checkpoint_at IS 
  'Timestamp of the most recent checkpoint append. Used to measure checkpoint freshness.';

COMMENT ON FUNCTION log_query_checkpoint(text, text, text, text, text, integer, numeric, text[], text[]) IS 
  'Log a query checkpoint to god_status. Captures success/failure signature, execution metrics, and semantic tags. Auto-maintains last 1000 checkpoints.';

COMMENT ON FUNCTION get_conversation_depth_metrics() IS 
  'Analyze checkpoint history and return comprehensive conversation-depth metrics: success rate, query type distribution, error patterns, tables accessed, and confidence score.';

COMMENT ON FUNCTION reset_conversation_checkpoints() IS 
  'Clear all checkpoints and reset confidence metrics. Use after conversation baseline shift.';
