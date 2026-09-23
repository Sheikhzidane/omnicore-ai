-- Agent Exec SQL LIMIT Injection Wrapper
-- Enforces automatic query bounds at invocation boundary
-- 
-- This migration adds a safety layer to agent_exec_sql() to prevent
-- large unintended result sets by automatically injecting LIMIT clauses
-- into SELECT statements when appropriate.

-- ============================================================================
-- 1. Helper Function: Detect if query is a SELECT statement
-- ============================================================================
CREATE OR REPLACE FUNCTION is_select_query(p_query text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trimmed text;
BEGIN
  -- Trim whitespace and convert to uppercase for comparison
  v_trimmed := upper(btrim(p_query));
  
  -- Check if query starts with SELECT (accounting for WITH clauses)
  RETURN v_trimmed LIKE 'SELECT%' 
      OR v_trimmed LIKE 'WITH%'
      OR v_trimmed LIKE '(%SELECT%';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

COMMENT ON FUNCTION is_select_query(text) IS
  'Safely detects if a query is a SELECT statement (including CTEs and subqueries)';

-- ============================================================================
-- 2. Helper Function: Detect if query already has a LIMIT clause
-- ============================================================================
CREATE OR REPLACE FUNCTION has_limit_clause(p_query text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trimmed text;
  v_upper text;
BEGIN
  -- Remove leading/trailing whitespace and comments
  v_trimmed := btrim(p_query);
  v_upper := upper(v_trimmed);
  
  -- Check for LIMIT keyword (word boundary aware)
  -- Match: LIMIT <number>, LIMIT $1, LIMIT ALL, LIMIT ?
  RETURN v_upper ~ '\sLIMIT\s+(\d+|[a-zA-Z_][a-zA-Z0-9_]*|ALL)\s*(OFFSET|\s*;?\s*)?$'
      OR v_upper ~ '\sLIMIT\s+(\d+|[a-zA-Z_][a-zA-Z0-9_]*|ALL)\s*\)\s*';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

COMMENT ON FUNCTION has_limit_clause(text) IS
  'Detects if a SELECT query already contains a LIMIT clause to avoid double-limiting';

-- ============================================================================
-- 3. Main Helper Function: Inject LIMIT clause safely
-- ============================================================================
CREATE OR REPLACE FUNCTION inject_limit_safely(
  p_query text,
  p_max_rows integer DEFAULT 10000
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text;
  v_max_rows integer;
BEGIN
  -- Validate inputs
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RETURN p_query;
  END IF;
  
  IF p_max_rows IS NULL OR p_max_rows < 1 THEN
    v_max_rows := 10000;
  ELSE
    v_max_rows := p_max_rows;
  END IF;
  
  -- Only process SELECT statements
  IF NOT is_select_query(p_query) THEN
    RETURN p_query;
  END IF;
  
  -- Skip if query already has LIMIT
  IF has_limit_clause(p_query) THEN
    RETURN p_query;
  END IF;
  
  -- Get trimmed query
  v_query := btrim(p_query);
  
  -- Remove trailing semicolon if present
  IF right(v_query, 1) = ';' THEN
    v_query := left(v_query, length(v_query) - 1);
  END IF;
  
  -- Inject LIMIT at the end
  RETURN v_query || ' LIMIT ' || v_max_rows;
EXCEPTION WHEN OTHERS THEN
  -- On any error, return original query (fail-safe)
  RETURN p_query;
END;
$$;

COMMENT ON FUNCTION inject_limit_safely(text, integer) IS
  'Safely injects LIMIT clause into SELECT queries without existing LIMIT clauses. Default 10000 rows.';

-- ============================================================================
-- 4. Enhanced agent_exec_sql with max_rows parameter
-- ============================================================================
-- This creates a new overload that accepts a max_rows limit parameter
-- The original single-parameter version remains for backward compatibility

CREATE OR REPLACE FUNCTION agent_exec_sql(
  query text,
  p_max_rows integer DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  v_query text;
  v_max_rows integer;
BEGIN
  -- Validate max_rows
  IF p_max_rows IS NULL OR p_max_rows < 1 THEN
    v_max_rows := 10000;
  ELSE
    v_max_rows := least(p_max_rows, 1000000);  -- Cap at 1M to prevent runaway
  END IF;
  
  -- Inject LIMIT if it's a SELECT query without one
  v_query := inject_limit_safely(query, v_max_rows);
  
  -- Execute with safety wrapper
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || v_query || ') t'
  INTO result;
  
  RETURN COALESCE(result, '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE,
    'query_attempted', query,
    'max_rows_limit', v_max_rows
  );
END;
$$;

COMMENT ON FUNCTION agent_exec_sql(text, integer) IS
  'Execute SELECT query with automatic LIMIT injection. Enforces query bounds at invocation boundary.';

-- ============================================================================
-- 5. Internal Logging Table for Query Limit Events (Optional)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.agent_exec_sql_limit_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash      text        NOT NULL,
  query_snippet   text,                  -- first 500 chars for debugging
  max_rows_limit  integer     NOT NULL,
  limit_injected  boolean     NOT NULL DEFAULT false,
  had_existing_limit boolean  NOT NULL DEFAULT false,
  was_select      boolean     NOT NULL DEFAULT false,
  error_occurred  boolean     NOT NULL DEFAULT false,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_limit_events_hash
  ON public.agent_exec_sql_limit_events (query_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_limit_events_limit_injected
  ON public.agent_exec_sql_limit_events (limit_injected, created_at DESC);

COMMENT ON TABLE public.agent_exec_sql_limit_events IS
  'Audit log for LIMIT injection decisions and query execution bounds';

-- ============================================================================
-- 6. Configuration Table for Query Execution Limits
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.agent_exec_sql_config (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key      text        NOT NULL UNIQUE,
  config_value    text        NOT NULL,
  description     text,
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Insert default configuration
INSERT INTO public.agent_exec_sql_config (config_key, config_value, description, enabled)
VALUES 
  ('default_limit', '10000', 'Default LIMIT for queries without explicit LIMIT clause', true),
  ('max_limit_allowed', '1000000', 'Maximum LIMIT that can be requested (safety cap)', true),
  ('enable_limit_injection', 'true', 'Enable automatic LIMIT injection for SELECT queries', true),
  ('audit_limit_injections', 'false', 'Log all LIMIT injection decisions to agent_exec_sql_limit_events', false)
ON CONFLICT (config_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_config_key
  ON public.agent_exec_sql_config (config_key);

COMMENT ON TABLE public.agent_exec_sql_config IS
  'Configuration parameters for agent_exec_sql LIMIT injection behavior';

-- ============================================================================
-- 7. Grant Permissions
-- ============================================================================
GRANT EXECUTE ON FUNCTION is_select_query(text) TO service_role;
GRANT EXECUTE ON FUNCTION has_limit_clause(text) TO service_role;
GRANT EXECUTE ON FUNCTION inject_limit_safely(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_sql(text, integer) TO service_role;

GRANT SELECT, INSERT ON TABLE public.agent_exec_sql_limit_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_exec_sql_config TO service_role;

-- ============================================================================
-- 8. Documentation
-- ============================================================================
COMMENT ON MIGRATION IS
  'Add automatic LIMIT injection wrapper around agent_exec_sql to enforce query bounds at invocation boundary';
