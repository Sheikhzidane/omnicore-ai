-- Pattern Detection System: Identify recurring problem-solving patterns across conversations
-- This migration creates tables and functions to detect recurring tool sequences, problem types,
-- and solution strategies used across multiple user conversations/tasks.

-- ============================================================================
-- TABLE: problem_categories
-- Taxonomy of problem types across conversations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.problem_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name text NOT NULL UNIQUE,
  description text,
  keywords text[] DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now()
);

-- ============================================================================
-- TABLE: tool_sequences
-- Records sequences of tools used together to solve problems
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.tool_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.todos(id) ON DELETE CASCADE,
  -- Array of tool names in order: e.g. ['read_file', 'patch_file', 'tsc_check']
  tool_sequence text[] NOT NULL,
  -- Hash of sequence for quick duplicate detection
  sequence_hash text NOT NULL,
  -- Count of distinct tasks that have used this exact sequence
  occurrence_count integer DEFAULT 1,
  -- Estimated success rate (% of tasks using this sequence that succeeded)
  success_rate numeric(3,2) DEFAULT 1.0,
  -- JSON metadata about the sequence (domain, context)
  context jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_sequences_hash ON public.tool_sequences(sequence_hash);

-- ============================================================================
-- TABLE: problem_solving_patterns
-- Detected patterns linking problem categories to solution methods
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.problem_solving_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- e.g. 'database_schema_query', 'type_error_fix', 'file_modification'
  pattern_type text NOT NULL,
  problem_category_id uuid REFERENCES public.problem_categories(id) ON DELETE SET NULL,
  -- Most common tool sequence for this pattern
  primary_tool_sequence text[] NOT NULL,
  -- Alternative tool sequences that solve the same problem
  alternative_sequences text[][] DEFAULT '{}',
  -- Number of distinct conversations/tasks exhibiting this pattern
  task_count integer DEFAULT 1,
  -- Avg success rate when this pattern is applied
  avg_success_rate numeric(3,2) DEFAULT 1.0,
  -- Description of when/why this pattern works
  solution_description text,
  -- Domain tags: 'database', 'file_io', 'type_checking', 'testing', etc.
  domain_tags text[] DEFAULT '{}',
  -- Timestamp statistics
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- ============================================================================
-- TABLE: pattern_occurrences
-- Join table: tracks each time a pattern is detected in a task
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pattern_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES public.problem_solving_patterns(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.todos(id) ON DELETE CASCADE,
  tool_sequence_id uuid REFERENCES public.tool_sequences(id) ON DELETE SET NULL,
  -- Did the task succeed using this pattern?
  succeeded boolean DEFAULT true,
  -- Duration in milliseconds for this task
  duration_ms integer,
  -- Which agent executed this pattern
  agent_id text,
  -- Similarity score to the canonical pattern (0-1)
  similarity_score numeric(3,2) DEFAULT 1.0,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pattern_occurrences_pattern ON public.pattern_occurrences(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_occurrences_task ON public.pattern_occurrences(task_id);

-- ============================================================================
-- TABLE: conversation_pattern_clusters
-- Groups conversations with similar problem-solving approaches
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.conversation_pattern_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_name text NOT NULL,
  -- List of problem_solving_pattern IDs that characterize this cluster
  pattern_ids uuid[] NOT NULL,
  -- List of task IDs in this cluster
  task_ids uuid[] NOT NULL DEFAULT '{}',
  -- Size of cluster
  cluster_size integer DEFAULT 1,
  -- Common characteristics across tasks
  common_traits jsonb DEFAULT '{}',
  -- Recommendation: what a new user with similar problem should try
  recommended_approach text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- ============================================================================
-- FUNCTION: extract_tool_sequence_from_task(task_id)
-- Extracts the ordered sequence of tools used for a given task
-- ============================================================================
CREATE OR REPLACE FUNCTION public.extract_tool_sequence_from_task(p_task_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_agg(tool_name ORDER BY created_at)
  FROM public.traces
  WHERE task_id = p_task_id
  GROUP BY task_id;
$$;

-- ============================================================================
-- FUNCTION: compute_sequence_hash(tool_sequence)
-- Generates deterministic hash of a tool sequence for deduplication
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_sequence_hash(p_sequence text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(array_to_string(p_sequence, '|'), 'sha256'),
    'hex'
  );
$$;

-- ============================================================================
-- FUNCTION: detect_patterns()
-- Main analysis function: processes all completed tasks and detects recurring patterns
-- Returns: newly detected patterns
-- ============================================================================
CREATE OR REPLACE FUNCTION public.detect_patterns()
RETURNS TABLE (
  pattern_type text,
  tool_sequence text[],
  task_count integer,
  avg_success_rate numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_tool_sequence text[];
  v_hash text;
  v_seq_id uuid;
  v_task_count integer;
  v_success_rate numeric;
  v_pattern_id uuid;
BEGIN
  -- Step 1: Extract and deduplicate tool sequences from all completed tasks
  INSERT INTO public.tool_sequences (task_id, tool_sequence, sequence_hash)
  SELECT 
    t.id,
    extract_tool_sequence_from_task(t.id) as tool_seq,
    compute_sequence_hash(extract_tool_sequence_from_task(t.id)) as seq_hash
  FROM public.todos t
  WHERE t.status = 'completed'
    AND extract_tool_sequence_from_task(t.id) IS NOT NULL
    AND array_length(extract_tool_sequence_from_task(t.id), 1) > 0
  ON CONFLICT (sequence_hash) DO UPDATE SET
    occurrence_count = tool_sequences.occurrence_count + 1,
    updated_at = now();

  -- Step 2: Identify patterns (sequences used in 2+ tasks = recurring pattern)
  INSERT INTO public.problem_solving_patterns (pattern_type, primary_tool_sequence, task_count, domain_tags)
  SELECT
    'tool_sequence_' || row_number() OVER (ORDER BY ts.occurrence_count DESC),
    ts.tool_sequence,
    ts.occurrence_count,
    array_agg(DISTINCT t.task_category) FILTER (WHERE t.task_category IS NOT NULL)
  FROM public.tool_sequences ts
  JOIN public.todos t ON t.id = ts.task_id
  WHERE ts.occurrence_count >= 2
  GROUP BY ts.tool_sequence, ts.occurrence_count
  ON CONFLICT DO NOTHING;

  -- Step 3: Record pattern occurrences for analytics
  INSERT INTO public.pattern_occurrences (pattern_id, task_id, tool_sequence_id, agent_id, duration_ms)
  SELECT
    psp.id,
    t.id,
    ts.id,
    t.assigned_agent,
    COALESCE((
      SELECT SUM(duration_ms)
      FROM public.traces
      WHERE task_id = t.id
    ), 0)::integer
  FROM public.problem_solving_patterns psp
  JOIN public.tool_sequences ts ON ts.tool_sequence = psp.primary_tool_sequence
  JOIN public.todos t ON t.id = ts.task_id
  ON CONFLICT DO NOTHING;

  -- Step 4: Return detected patterns for audit
  RETURN QUERY
  SELECT
    psp.pattern_type,
    psp.primary_tool_sequence,
    psp.task_count,
    COALESCE(AVG(po.succeeded::int)::numeric, 1.0) as avg_success
  FROM public.problem_solving_patterns psp
  LEFT JOIN public.pattern_occurrences po ON po.pattern_id = psp.id
  WHERE psp.created_at > now() - interval '1 day'  -- newly created patterns
  GROUP BY psp.id, psp.pattern_type, psp.primary_tool_sequence, psp.task_count
  ORDER BY psp.task_count DESC;
END;
$$;

-- ============================================================================
-- FUNCTION: find_similar_patterns(problem_description)
-- Given a problem description, finds similar historical patterns
-- ============================================================================
CREATE OR REPLACE FUNCTION public.find_similar_patterns(p_problem_description text)
RETURNS TABLE (
  pattern_id uuid,
  pattern_type text,
  tool_sequence text[],
  task_count integer,
  avg_success_rate numeric,
  similarity_score numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH problem_tokens AS (
    SELECT regexp_split_to_table(lower(p_problem_description), '\s+') as token
  ),
  matching_tasks AS (
    SELECT 
      t.id,
      COUNT(DISTINCT pt.token) as matching_tokens
    FROM public.todos t
    CROSS JOIN problem_tokens pt
    WHERE t.status = 'completed'
      AND (lower(t.title) LIKE '%' || pt.token || '%'
           OR lower(t.description) LIKE '%' || pt.token || '%')
    GROUP BY t.id
  )
  SELECT
    psp.id,
    psp.pattern_type,
    psp.primary_tool_sequence,
    psp.task_count,
    COALESCE(AVG(po.succeeded::int)::numeric, 1.0),
    (CAST(COUNT(DISTINCT mt.id) as numeric) / 
     NULLIF(COUNT(DISTINCT po.task_id), 0))::numeric as sim_score
  FROM public.problem_solving_patterns psp
  LEFT JOIN public.pattern_occurrences po ON po.pattern_id = psp.id
  LEFT JOIN matching_tasks mt ON mt.id = po.task_id
  GROUP BY psp.id, psp.pattern_type, psp.primary_tool_sequence, psp.task_count
  HAVING COUNT(DISTINCT mt.id) > 0
  ORDER BY sim_score DESC
  LIMIT 5;
$$;

-- ============================================================================
-- FUNCTION: create_pattern_cluster(cluster_name, pattern_ids)
-- Groups related patterns into a logical cluster
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_pattern_cluster(
  p_cluster_name text,
  p_pattern_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_cluster_id uuid;
  v_task_ids uuid[];
BEGIN
  -- Collect all tasks that use any of these patterns
  SELECT array_agg(DISTINCT task_id)
  INTO v_task_ids
  FROM public.pattern_occurrences
  WHERE pattern_id = ANY(p_pattern_ids);

  INSERT INTO public.conversation_pattern_clusters (
    cluster_name,
    pattern_ids,
    task_ids,
    cluster_size
  ) VALUES (
    p_cluster_name,
    p_pattern_ids,
    COALESCE(v_task_ids, '{}'),
    COALESCE(array_length(v_task_ids, 1), 0)
  )
  RETURNING id INTO v_cluster_id;

  RETURN v_cluster_id;
END;
$$;

-- ============================================================================
-- FUNCTION: get_pattern_recommendations(task_category)
-- Returns recommended tool sequences for a given problem category
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_pattern_recommendations(p_category text)
RETURNS TABLE (
  pattern_id uuid,
  recommended_sequence text[],
  success_rate numeric,
  alternative_sequences text[][]
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    psp.id,
    psp.primary_tool_sequence,
    COALESCE(AVG(po.succeeded::int)::numeric, 1.0),
    psp.alternative_sequences
  FROM public.problem_solving_patterns psp
  LEFT JOIN public.pattern_occurrences po ON po.pattern_id = psp.id
  WHERE p_category = ANY(psp.domain_tags)
  GROUP BY psp.id, psp.primary_tool_sequence, psp.alternative_sequences
  ORDER BY success_rate DESC, psp.task_count DESC
  LIMIT 10;
$$;

-- ============================================================================
-- INDEXES for performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_problem_categories_keywords ON public.problem_categories USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_tool_sequences_task ON public.tool_sequences(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_sequences_sequence ON public.tool_sequences USING GIN(tool_sequence);
CREATE INDEX IF NOT EXISTS idx_problem_solving_patterns_domain ON public.problem_solving_patterns USING GIN(domain_tags);
CREATE INDEX IF NOT EXISTS idx_conversation_clusters_patterns ON public.conversation_pattern_clusters USING GIN(pattern_ids);
CREATE INDEX IF NOT EXISTS idx_conversation_clusters_tasks ON public.conversation_pattern_clusters USING GIN(task_ids);

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT SELECT, INSERT, UPDATE ON public.problem_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tool_sequences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.problem_solving_patterns TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pattern_occurrences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_pattern_clusters TO authenticated;

GRANT EXECUTE ON FUNCTION public.extract_tool_sequence_from_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_sequence_hash(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.detect_patterns() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_similar_patterns(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_pattern_cluster(text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pattern_recommendations(text) TO authenticated;
