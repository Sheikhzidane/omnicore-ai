/**
 * Migration: 0029_task_followup_tracking.sql
 *
 * Tracks task types and follow-up question patterns.
 *
 * Purpose:
 * - Log which task types receive follow-up questions vs. silent acceptance
 * - Categorize tasks by type (bug, feature, enhancement, support, documentation, etc.)
 * - Track conversation depth and user engagement per task
 * - Analyze patterns between task category and follow-up frequency
 *
 * Key tables:
 * - task_followup_log: Logs each task with its type and whether follow-ups occurred
 * - task_type_statistics: Aggregate statistics by task type
 */

-- ============================================================================
-- Step 1: Create task_followup_log table
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_followup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Task identification
  task_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  conversation_id text,
  
  -- Task classification
  task_type text NOT NULL DEFAULT 'other',
  -- Valid types: 'bug', 'feature', 'enhancement', 'support', 'documentation', 'question', 'chore', 'other'
  
  -- Follow-up tracking
  has_followup_questions boolean DEFAULT FALSE,
  followup_count integer DEFAULT 0,
  followup_turn_count integer DEFAULT 0,
  
  -- User engagement metrics
  total_turns integer DEFAULT 1,
  avg_response_length integer DEFAULT 0,
  max_response_length integer DEFAULT 0,
  
  -- Clarification patterns
  contains_clarification_request boolean DEFAULT FALSE,
  contains_additional_context boolean DEFAULT FALSE,
  contains_alternative_approach boolean DEFAULT FALSE,
  contains_scope_change boolean DEFAULT FALSE,
  
  -- Acceptance pattern
  silently_accepted boolean DEFAULT FALSE,
  -- TRUE if task moved to completed/done without any clarification
  
  -- Metadata
  agent_id text,
  user_id text,
  session_id text,
  
  -- Timestamps
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  first_followup_at timestamp with time zone,
  completed_at timestamp with time zone
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_task_followup_log_task_id
ON task_followup_log(task_id);

CREATE INDEX IF NOT EXISTS idx_task_followup_log_conversation_id
ON task_followup_log(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_followup_log_task_type
ON task_followup_log(task_type);

CREATE INDEX IF NOT EXISTS idx_task_followup_log_has_followup
ON task_followup_log(has_followup_questions, task_type);

CREATE INDEX IF NOT EXISTS idx_task_followup_log_created_at
ON task_followup_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_followup_log_silently_accepted
ON task_followup_log(silently_accepted, task_type);

-- ============================================================================
-- Step 2: Create task_type_statistics aggregate table
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_type_statistics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Aggregation key
  task_type text NOT NULL UNIQUE,
  
  -- Counts
  total_tasks integer DEFAULT 0,
  tasks_with_followup integer DEFAULT 0,
  silently_accepted_tasks integer DEFAULT 0,
  
  -- Percentages
  followup_percentage numeric DEFAULT 0,
  silent_acceptance_percentage numeric DEFAULT 0,
  
  -- Averages
  avg_followup_count numeric DEFAULT 0,
  avg_total_turns numeric DEFAULT 0,
  avg_response_length numeric DEFAULT 0,
  
  -- Most common follow-up reasons (JSONB array)
  common_followup_patterns jsonb DEFAULT '[]'::jsonb,
  -- Format: [{"pattern": "clarification", "count": 42}, ...]
  
  -- Time metrics
  avg_time_to_first_followup_seconds integer,
  avg_completion_time_seconds integer,
  
  -- Updated statistics
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_computed_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_task_type_statistics_task_type
ON task_type_statistics(task_type);

CREATE INDEX IF NOT EXISTS idx_task_type_statistics_followup_percentage
ON task_type_statistics(followup_percentage DESC);

-- ============================================================================
-- Step 3: Create function to log task and followup info
-- ============================================================================

CREATE OR REPLACE FUNCTION log_task_followup(
  p_task_id uuid,
  p_task_type text DEFAULT 'other',
  p_conversation_id text DEFAULT NULL,
  p_has_followup boolean DEFAULT FALSE,
  p_silently_accepted boolean DEFAULT TRUE,
  p_agent_id text DEFAULT NULL,
  p_user_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_existing_record uuid;
BEGIN
  -- Check if we already have a log entry for this task
  SELECT id INTO v_existing_record
  FROM task_followup_log
  WHERE task_id = p_task_id
  LIMIT 1;

  IF v_existing_record IS NULL THEN
    -- Create new log entry
    INSERT INTO task_followup_log (
      task_id,
      conversation_id,
      task_type,
      has_followup_questions,
      silently_accepted,
      agent_id,
      user_id,
      created_at,
      updated_at
    ) VALUES (
      p_task_id,
      p_conversation_id,
      p_task_type,
      p_has_followup,
      p_silently_accepted,
      p_agent_id,
      p_user_id,
      now(),
      now()
    );

    v_result := jsonb_build_object(
      'success', TRUE,
      'action', 'created',
      'task_id', p_task_id,
      'task_type', p_task_type,
      'has_followup', p_has_followup,
      'silently_accepted', p_silently_accepted
    );
  ELSE
    -- Update existing log entry
    UPDATE task_followup_log
    SET
      has_followup_questions = p_has_followup,
      silently_accepted = p_silently_accepted,
      updated_at = now()
    WHERE task_id = p_task_id;

    v_result := jsonb_build_object(
      'success', TRUE,
      'action', 'updated',
      'task_id', p_task_id,
      'task_type', p_task_type,
      'has_followup', p_has_followup,
      'silently_accepted', p_silently_accepted
    );
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION log_task_followup(uuid, text, text, boolean, boolean, text, text) TO service_role;

-- ============================================================================
-- Step 4: Create function to increment followup count
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_task_followup_count(
  p_task_id uuid,
  p_followup_pattern text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_record_exists boolean;
BEGIN
  -- Check if record exists
  SELECT EXISTS(SELECT 1 FROM task_followup_log WHERE task_id = p_task_id)
  INTO v_record_exists;

  IF NOT v_record_exists THEN
    -- Create a new record if it doesn't exist
    INSERT INTO task_followup_log (
      task_id,
      has_followup_questions,
      followup_count,
      followup_turn_count,
      total_turns,
      first_followup_at,
      silently_accepted,
      created_at,
      updated_at
    ) VALUES (
      p_task_id,
      TRUE,
      1,
      1,
      1,
      now(),
      FALSE,
      now(),
      now()
    );
  ELSE
    -- Update existing record
    UPDATE task_followup_log
    SET
      has_followup_questions = TRUE,
      followup_count = followup_count + 1,
      followup_turn_count = followup_turn_count + 1,
      silently_accepted = FALSE,
      first_followup_at = COALESCE(first_followup_at, now()),
      updated_at = now()
    WHERE task_id = p_task_id;
  END IF;

  v_result := jsonb_build_object(
    'success', TRUE,
    'task_id', p_task_id,
    'followup_pattern', p_followup_pattern,
    'timestamp', now()
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_task_followup_count(uuid, text) TO service_role;

-- ============================================================================
-- Step 5: Create function to compute task_type_statistics
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_task_type_statistics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_type text;
  v_total integer;
  v_with_followup integer;
  v_silently_accepted integer;
  v_result jsonb := '{}'::jsonb;
BEGIN
  -- Clear and recompute statistics
  TRUNCATE task_type_statistics;

  -- For each task type, compute aggregates
  FOR v_task_type IN SELECT DISTINCT task_type FROM task_followup_log
  LOOP
    SELECT
      COUNT(*)::integer,
      SUM(CASE WHEN has_followup_questions THEN 1 ELSE 0 END)::integer,
      SUM(CASE WHEN silently_accepted THEN 1 ELSE 0 END)::integer
    INTO
      v_total,
      v_with_followup,
      v_silently_accepted
    FROM task_followup_log
    WHERE task_type = v_task_type;

    -- Insert computed statistics
    INSERT INTO task_type_statistics (
      task_type,
      total_tasks,
      tasks_with_followup,
      silently_accepted_tasks,
      followup_percentage,
      silent_acceptance_percentage,
      avg_followup_count,
      avg_total_turns,
      last_computed_at,
      updated_at
    )
    SELECT
      v_task_type,
      v_total,
      v_with_followup,
      v_silently_accepted,
      CASE WHEN v_total > 0 THEN (v_with_followup::numeric / v_total * 100) ELSE 0 END,
      CASE WHEN v_total > 0 THEN (v_silently_accepted::numeric / v_total * 100) ELSE 0 END,
      COALESCE((SELECT AVG(followup_count)::numeric FROM task_followup_log WHERE task_type = v_task_type), 0),
      COALESCE((SELECT AVG(total_turns)::numeric FROM task_followup_log WHERE task_type = v_task_type), 1),
      now(),
      now();

    v_result := v_result || jsonb_build_object(
      v_task_type, jsonb_build_object(
        'total', v_total,
        'with_followup', v_with_followup,
        'silently_accepted', v_silently_accepted
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', TRUE,
    'statistics_computed', v_result,
    'timestamp', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION compute_task_type_statistics() TO service_role;

-- ============================================================================
-- Step 6: Create view for easy querying
-- ============================================================================

CREATE OR REPLACE VIEW task_followup_summary AS
SELECT
  t.task_type,
  COUNT(*) as total_tasks,
  SUM(CASE WHEN t.has_followup_questions THEN 1 ELSE 0 END) as tasks_with_followup,
  SUM(CASE WHEN t.silently_accepted THEN 1 ELSE 0 END) as silently_accepted,
  ROUND(
    100.0 * SUM(CASE WHEN t.has_followup_questions THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) as followup_percentage,
  ROUND(AVG(t.followup_count), 2) as avg_followup_count,
  ROUND(AVG(t.total_turns), 2) as avg_turns
FROM task_followup_log t
GROUP BY t.task_type
ORDER BY t.task_type;

-- ============================================================================
-- Step 7: Enable RLS for security
-- ============================================================================

ALTER TABLE task_followup_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_type_statistics ENABLE ROW LEVEL SECURITY;

-- Allow service role and authenticated users to read
CREATE POLICY task_followup_log_select ON task_followup_log
FOR SELECT
USING (TRUE);

CREATE POLICY task_type_statistics_select ON task_type_statistics
FOR SELECT
USING (TRUE);

-- Allow service role to insert/update
CREATE POLICY task_followup_log_insert ON task_followup_log
FOR INSERT
WITH CHECK (TRUE);

CREATE POLICY task_followup_log_update ON task_followup_log
FOR UPDATE
USING (TRUE)
WITH CHECK (TRUE);

CREATE POLICY task_type_statistics_insert ON task_type_statistics
FOR INSERT
WITH CHECK (TRUE);

CREATE POLICY task_type_statistics_update ON task_type_statistics
FOR UPDATE
USING (TRUE)
WITH CHECK (TRUE);
