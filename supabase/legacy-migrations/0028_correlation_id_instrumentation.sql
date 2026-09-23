/**
 * Migration: 0028_correlation_id_instrumentation.sql
 * 
 * Adds correlation_id support for agent_exec_sql call site instrumentation.
 * 
 * Purpose:
 * - Adds correlation_id column to agent_sql_execution_log for request tracing
 * - Implements batch_record_execution_checkpoints function for task_history batching
 * - Enhanced agent_exec_sql function signature to accept and log correlation_id
 * 
 * Design:
 * - correlation_id: uuid type, nullable, indexed for efficient lookups
 * - Batching uses bounded queue pattern (max 1000 records before flush)
 * - Checkpoint records track execution state for observability
 */

-- ============================================================================
-- Step 1: Add correlation_id support to agent_sql_execution_log
-- ============================================================================

ALTER TABLE agent_sql_execution_log
ADD COLUMN IF NOT EXISTS correlation_id uuid;

CREATE INDEX IF NOT EXISTS idx_agent_sql_execution_log_correlation_id
ON agent_sql_execution_log(correlation_id);

-- Optional unique index for request deduplication patterns
CREATE INDEX IF NOT EXISTS idx_agent_sql_execution_log_correlation_id_created_at
ON agent_sql_execution_log(correlation_id, created_at DESC)
WHERE correlation_id IS NOT NULL;

-- ============================================================================
-- Step 2: Batching checkpoint table (if needed for bounded queue pattern)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_execution_checkpoint_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  task_id uuid NOT NULL,
  action text NOT NULL,
  old_values jsonb DEFAULT '{}'::jsonb,
  new_values jsonb DEFAULT '{}'::jsonb,
  correlation_id uuid,
  queued_at timestamp with time zone DEFAULT now(),
  processed_at timestamp with time zone,
  processed boolean DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_queue_batch_id
ON agent_execution_checkpoint_queue(batch_id);

CREATE INDEX IF NOT EXISTS idx_checkpoint_queue_processed
ON agent_execution_checkpoint_queue(processed, queued_at);

CREATE INDEX IF NOT EXISTS idx_checkpoint_queue_correlation_id
ON agent_execution_checkpoint_queue(correlation_id)
WHERE correlation_id IS NOT NULL;

-- ============================================================================
-- Step 3: Enhanced agent_exec_sql function with correlation_id support
-- ============================================================================

CREATE OR REPLACE FUNCTION agent_exec_sql(
  query text,
  p_correlation_id uuid DEFAULT NULL,
  p_task_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  exec_id uuid;
  exec_start_time timestamp with time zone;
  exec_end_time timestamp with time zone;
  exec_time_ms integer;
  rows_returned integer;
  exec_status text := 'pending';
  exec_error_code text := NULL;
  exec_error_message text := NULL;
  exec_error_context jsonb := NULL;
BEGIN
  -- Record execution start
  exec_id := gen_random_uuid();
  exec_start_time := now();

  -- Execute the query
  BEGIN
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || query || ') t'
    INTO result;
    
    -- Count returned rows
    rows_returned := COALESCE(jsonb_array_length(result), 0);
    exec_status := 'success';
    result := COALESCE(result, '[]'::jsonb);

  EXCEPTION WHEN OTHERS THEN
    exec_status := 'failed';
    exec_error_code := SQLSTATE;
    exec_error_message := SQLERRM;
    exec_error_context := jsonb_build_object(
      'error_detail', 'Query execution failed',
      'query_snippet', LEFT(query, 200)
    );
    result := jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
    rows_returned := 0;
  END;

  -- Calculate execution time
  exec_end_time := now();
  exec_time_ms := EXTRACT(EPOCH FROM (exec_end_time - exec_start_time))::integer * 1000;

  -- Log execution to agent_sql_execution_log with correlation_id
  INSERT INTO agent_sql_execution_log (
    id,
    query,
    execution_status,
    error_code,
    error_message,
    error_context,
    rows_affected,
    execution_time_ms,
    result_summary,
    tool_name,
    task_id,
    correlation_id,
    agent_name,
    created_at,
    updated_at
  ) VALUES (
    exec_id,
    LEFT(query, 8000),
    exec_status,
    exec_error_code,
    exec_error_message,
    exec_error_context,
    rows_returned,
    exec_time_ms,
    CASE WHEN exec_status = 'success' THEN 'OK' ELSE 'FAILED' END,
    'agent_exec_sql',
    p_task_id,
    p_correlation_id,
    'agent',
    exec_start_time,
    exec_end_time
  );

  RETURN result;
END;
$$;

-- Grant permission to service role
GRANT EXECUTE ON FUNCTION agent_exec_sql(text, uuid, uuid) TO service_role;

-- Backward compatibility: keep old signature working
CREATE OR REPLACE FUNCTION agent_exec_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN agent_exec_sql(query, NULL::uuid, NULL::uuid);
END;
$$;

GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO service_role;

-- ============================================================================
-- Step 4: batch_record_execution_checkpoints function
-- ============================================================================

CREATE OR REPLACE FUNCTION batch_record_execution_checkpoints(
  p_batch_id uuid,
  p_records jsonb,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record jsonb;
  v_record_count integer := 0;
  v_inserted_count integer := 0;
  v_error_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_task_id uuid;
  v_action text;
  v_old_values jsonb;
  v_new_values jsonb;
BEGIN
  -- Validate input
  IF p_batch_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'error', 'batch_id is required',
      'batch_id', NULL,
      'records_processed', 0,
      'records_inserted', 0,
      'errors', v_errors
    );
  END IF;

  IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'batch_id', p_batch_id,
      'records_processed', 0,
      'records_inserted', 0,
      'errors', v_errors
    );
  END IF;

  -- Process each record in the batch
  FOR v_record IN SELECT jsonb_array_elements(p_records)
  LOOP
    v_record_count := v_record_count + 1;

    BEGIN
      -- Extract fields from record
      v_task_id := v_record->>'task_id';
      v_action := v_record->>'action';
      v_old_values := COALESCE((v_record->'old_values')::jsonb, '{}'::jsonb);
      v_new_values := COALESCE((v_record->'new_values')::jsonb, '{}'::jsonb);

      -- Insert into checkpoint queue first (for deduplication)
      INSERT INTO agent_execution_checkpoint_queue (
        batch_id,
        task_id,
        action,
        old_values,
        new_values,
        correlation_id,
        processed
      ) VALUES (
        p_batch_id,
        v_task_id::uuid,
        v_action,
        v_old_values,
        v_new_values,
        p_correlation_id,
        FALSE
      )
      ON CONFLICT DO NOTHING;

      -- Then insert into actual task_history table
      INSERT INTO task_history (
        task_id,
        actor_id,
        actor_name,
        action,
        old_values,
        new_values,
        changed_at,
        created_at
      ) VALUES (
        v_task_id::uuid,
        p_batch_id,  -- Use batch_id as actor_id for system operations
        'batch_checkpoint',
        v_old_values,
        v_new_values,
        now(),
        now()
      );

      v_inserted_count := v_inserted_count + 1;

    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := v_errors || jsonb_build_object(
        'record_index', v_record_count,
        'task_id', v_task_id,
        'error', SQLERRM,
        'sqlstate', SQLSTATE
      );
    END;
  END LOOP;

  -- Mark queue items as processed
  UPDATE agent_execution_checkpoint_queue
  SET processed = TRUE,
      processed_at = now()
  WHERE batch_id = p_batch_id
    AND processed = FALSE;

  RETURN jsonb_build_object(
    'success', (v_error_count = 0),
    'batch_id', p_batch_id,
    'correlation_id', p_correlation_id,
    'records_processed', v_record_count,
    'records_inserted', v_inserted_count,
    'error_count', v_error_count,
    'errors', v_errors,
    'timestamp', now()::text
  );
END;
$$;

GRANT EXECUTE ON FUNCTION batch_record_execution_checkpoints(uuid, jsonb, uuid) TO service_role;

-- ============================================================================
-- Step 5: Utility function to flush checkpoint queue to task_history
-- ============================================================================

CREATE OR REPLACE FUNCTION flush_checkpoint_queue(
  p_batch_size integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queue_count integer;
  v_flushed_count integer := 0;
  v_failed_count integer := 0;
  v_batch_record record;
BEGIN
  -- Count pending records
  SELECT COUNT(*) INTO v_queue_count
  FROM agent_execution_checkpoint_queue
  WHERE processed = FALSE;

  IF v_queue_count = 0 THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'pending_records', 0,
      'flushed_count', 0,
      'failed_count', 0,
      'timestamp', now()::text
    );
  END IF;

  -- Process pending records in batches
  FOR v_batch_record IN
    SELECT * FROM agent_execution_checkpoint_queue
    WHERE processed = FALSE
    ORDER BY queued_at ASC
    LIMIT p_batch_size
  LOOP
    BEGIN
      INSERT INTO task_history (
        task_id,
        actor_id,
        actor_name,
        action,
        old_values,
        new_values,
        changed_at,
        created_at
      ) VALUES (
        v_batch_record.task_id,
        v_batch_record.batch_id,
        'batch_checkpoint_flush',
        v_batch_record.old_values,
        v_batch_record.new_values,
        now(),
        now()
      );

      UPDATE agent_execution_checkpoint_queue
      SET processed = TRUE,
          processed_at = now()
      WHERE id = v_batch_record.id;

      v_flushed_count := v_flushed_count + 1;

    EXCEPTION WHEN OTHERS THEN
      v_failed_count := v_failed_count + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', (v_failed_count = 0),
    'pending_records', v_queue_count,
    'flushed_count', v_flushed_count,
    'failed_count', v_failed_count,
    'timestamp', now()::text
  );
END;
$$;

GRANT EXECUTE ON FUNCTION flush_checkpoint_queue(integer) TO service_role;

-- ============================================================================
-- Step 6: Query functions for correlation_id tracing
-- ============================================================================

CREATE OR REPLACE FUNCTION get_execution_trace_by_correlation_id(
  p_correlation_id uuid
)
RETURNS TABLE (
  execution_id uuid,
  query text,
  status text,
  execution_time_ms integer,
  rows_affected integer,
  error_message text,
  created_at timestamp with time zone
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    id,
    query,
    execution_status,
    execution_time_ms,
    rows_affected,
    error_message,
    created_at
  FROM agent_sql_execution_log
  WHERE correlation_id = p_correlation_id
  ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION get_execution_trace_by_correlation_id(uuid) TO service_role;

CREATE OR REPLACE FUNCTION get_checkpoint_history_by_correlation_id(
  p_correlation_id uuid
)
RETURNS TABLE (
  task_id uuid,
  action text,
  old_values jsonb,
  new_values jsonb,
  created_at timestamp with time zone
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    task_id,
    action,
    old_values,
    new_values,
    created_at
  FROM task_history
  WHERE id IN (
    SELECT id FROM agent_execution_checkpoint_queue
    WHERE correlation_id = p_correlation_id
  )
  ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION get_checkpoint_history_by_correlation_id(uuid) TO service_role;

-- ============================================================================
-- Step 7: Test/verification queries (optional, can be removed)
-- ============================================================================

-- Verify schema changes
-- SELECT column_name, data_type FROM information_schema.columns 
-- WHERE table_name = 'agent_sql_execution_log' 
-- AND column_name IN ('correlation_id', 'id', 'query')
-- ORDER BY ordinal_position;
