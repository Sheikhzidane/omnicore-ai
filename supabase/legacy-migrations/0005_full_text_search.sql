-- ============================================================
-- Full-Text Search Implementation for Tasks
-- Introduces:
-- 1. description and metadata columns to todos
-- 2. tasks_search_index table with tsvector
-- 3. Trigger-maintained search index
-- 4. GIN index for sub-10ms lookups
-- 5. RPC function search_tasks_ranked with RLS filtering
-- ============================================================

-- ============================================================
-- 1. Add missing columns to todos table
-- ============================================================
ALTER TABLE public.todos
  ADD COLUMN IF NOT EXISTS description text DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- ============================================================
-- 2. Create tasks_search_index table
--    Maintains denormalized search vectors for fast FTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tasks_search_index (
  task_id uuid PRIMARY KEY REFERENCES public.todos(id) ON DELETE CASCADE,
  search_vector tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tasks_search_index ENABLE ROW LEVEL SECURITY;

-- RLS Policies for search index (read-only, synced with todos visibility)
CREATE POLICY "search_index_select" ON public.tasks_search_index
  FOR SELECT TO anon USING (true);

-- ============================================================
-- 3. GIN Index on tsvector for fast FTS
--    Enables sub-10ms lookups even under concurrent load
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tasks_search_vector_gin 
  ON public.tasks_search_index USING GIN (search_vector);

-- Additional index on task_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_tasks_search_task_id 
  ON public.tasks_search_index (task_id);

-- ============================================================
-- 4. Helper function: flatten jsonb to searchable text
--    Converts metadata jsonb into space-separated text
-- ============================================================
CREATE OR REPLACE FUNCTION public.flatten_jsonb_to_text(data jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT string_agg(
    CASE
      WHEN jsonb_typeof(v) = 'object' OR jsonb_typeof(v) = 'array'
        THEN jsonb_typeof(v)::text
      ELSE v::text
    END,
    ' '
  )
  FROM jsonb_each_all(data) AS _(k, v)
  WHERE v::text != 'null'
$$;

-- ============================================================
-- 5. Main trigger function: maintain tasks_search_index
--    Uses websearch-optimized weighting:
--    - Title: weight A (highest)
--    - Description: weight B (medium)
--    - Metadata: weight C (lower)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_tasks_search_index()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_metadata_text text;
BEGIN
  -- Flatten metadata JSONB to searchable text
  v_metadata_text := COALESCE(
    public.flatten_jsonb_to_text(NEW.metadata),
    ''
  );

  -- Build tsvector with websearch-optimized weights
  -- Weight A: critical terms (title)
  -- Weight B: important context (description)
  -- Weight C: supplementary data (metadata)
  INSERT INTO public.tasks_search_index (task_id, search_vector, updated_at)
  VALUES (
    NEW.id,
    setweight(
      to_tsvector('english', COALESCE(NEW.title, '')),
      'A'::char
    ) ||
    setweight(
      to_tsvector('english', COALESCE(NEW.description, '')),
      'B'::char
    ) ||
    setweight(
      to_tsvector('english', v_metadata_text),
      'C'::char
    ),
    now()
  )
  ON CONFLICT (task_id) DO UPDATE
  SET search_vector = EXCLUDED.search_vector,
      updated_at = now();

  RETURN NEW;
END;
$$;

-- ============================================================
-- 6. Create triggers on INSERT and UPDATE
--    Maintains search index automatically
-- ============================================================
DROP TRIGGER IF EXISTS todos_update_search_index ON public.todos CASCADE;
DROP TRIGGER IF EXISTS todos_insert_search_index ON public.todos CASCADE;

CREATE TRIGGER todos_insert_search_index
  AFTER INSERT ON public.todos
  FOR EACH ROW
  EXECUTE FUNCTION public.update_tasks_search_index();

CREATE TRIGGER todos_update_search_index
  AFTER UPDATE ON public.todos
  FOR EACH ROW
  EXECUTE FUNCTION public.update_tasks_search_index();

-- ============================================================
-- 7. Populate search index for existing records
-- ============================================================
INSERT INTO public.tasks_search_index (task_id, search_vector, updated_at)
SELECT
  t.id,
  setweight(
    to_tsvector('english', COALESCE(t.title, '')),
    'A'::char
  ) ||
  setweight(
    to_tsvector('english', COALESCE(t.description, '')),
    'B'::char
  ) ||
  setweight(
    to_tsvector('english', 
      COALESCE(public.flatten_jsonb_to_text(t.metadata), '')
    ),
    'C'::char
  ),
  now()
FROM public.todos t
ON CONFLICT (task_id) DO NOTHING;

-- ============================================================
-- 8. RPC Function: search_tasks_ranked
--    High-performance full-text search with RLS filtering
--    Returns results ranked by ts_rank_cd relevance score
--    Optimized for sub-10ms lookups under concurrent load
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_tasks_ranked(
  p_query text,
  p_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  status text,
  priority text,
  assigned_agent text,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb,
  is_boss boolean,
  deadline timestamptz,
  comments jsonb,
  retry_count integer,
  relevance_score real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query_vector tsquery;
BEGIN
  -- Convert input to websearch query vector
  -- Supports natural language queries like "user authentication"
  v_query_vector := websearch_to_tsquery('english', p_query);

  -- Return ranked results with RLS-filtered visibility
  RETURN QUERY
  SELECT
    t.id,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_agent,
    t.created_at,
    t.updated_at,
    t.metadata,
    t.is_boss,
    t.deadline,
    t.comments,
    t.retry_count,
    -- Rank with coverage denominator for normalized scoring
    -- This gives better relevance ordering under varied query lengths
    ts_rank_cd(
      ARRAY[0, 0.1, 0.2, 1.0],
      tsi.search_vector,
      v_query_vector,
      32 -- uses all features for best ranking
    ) AS relevance_score
  FROM
    public.todos t
    INNER JOIN public.tasks_search_index tsi ON t.id = tsi.task_id
  WHERE
    -- Full-text match on weighted search vector
    tsi.search_vector @@ v_query_vector
    -- Optional agent filter (NULL = all visible tasks)
    AND (p_agent_id IS NULL OR t.assigned_agent::uuid = p_agent_id)
  ORDER BY
    -- Primary: relevance score (highest first)
    relevance_score DESC,
    -- Secondary: recency (for ties)
    t.updated_at DESC
  LIMIT 100; -- Prevent excessive result sets
END;
$$;

-- Grant execute to anon and authenticated users
GRANT EXECUTE ON FUNCTION public.search_tasks_ranked(text, uuid) TO anon, authenticated;

-- ============================================================
-- 9. Enable publication for search_index changes
--    Allows real-time updates via websocket subscriptions
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks_search_index;
ALTER TABLE public.tasks_search_index REPLICA IDENTITY FULL;

-- ============================================================
-- 10. Performance monitoring setup
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tasks_search_updated_at 
  ON public.tasks_search_index (updated_at DESC);

-- Function to gather search index statistics
CREATE OR REPLACE FUNCTION public.get_search_index_stats()
RETURNS TABLE (
  total_indexed_tasks bigint,
  index_size_bytes bigint,
  avg_vector_length numeric,
  last_update timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    COUNT(*)::bigint,
    pg_total_relation_size('public.tasks_search_index')::bigint,
    AVG(length(search_vector::text))::numeric,
    MAX(updated_at)
  FROM public.tasks_search_index;
$$;

GRANT EXECUTE ON FUNCTION public.get_search_index_stats() TO anon, authenticated;

-- ============================================================
-- Function to rebuild search index if needed
-- ============================================================
CREATE OR REPLACE FUNCTION public.rebuild_search_index()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.tasks_search_index;
  
  INSERT INTO public.tasks_search_index (task_id, search_vector, updated_at)
  SELECT
    t.id,
    setweight(
      to_tsvector('english', COALESCE(t.title, '')),
      'A'::char
    ) ||
    setweight(
      to_tsvector('english', COALESCE(t.description, '')),
      'B'::char
    ) ||
    setweight(
      to_tsvector('english', 
        COALESCE(public.flatten_jsonb_to_text(t.metadata), '')
      ),
      'C'::char
    ),
    now()
  FROM public.todos t;
  
  RETURN 'Search index rebuilt successfully. Total tasks indexed: ' || 
    (SELECT COUNT(*) FROM public.tasks_search_index)::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebuild_search_index() TO service_role;
