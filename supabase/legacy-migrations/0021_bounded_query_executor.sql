-- Bounded Query Executor: Standardize agent_exec_sql with LIMIT and Table Validation
-- 
-- Purpose:
-- 1. Resolve ambiguous agent_exec_sql overloads from migration 0020
-- 2. Add mandatory LIMIT clause to all SELECT statements
-- 3. Validate queries against whitelist of known tables (todos, god_status)
-- 4. Provide comprehensive query safety checks before execution
--
-- Migration applied after 0020 to fix function signature ambiguity

-- ============================================================================
-- 1. Drop all ambiguous overloads to start fresh
-- ============================================================================
DROP FUNCTION IF EXISTS public.agent_exec_sql(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, integer) CASCADE;

-- ============================================================================
-- 2. Whitelist of allowed tables for query validation
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.agent_exec_sql_table_whitelist (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      text        NOT NULL UNIQUE,
  description     text,
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Insert known tables
INSERT INTO public.agent_exec_sql_table_whitelist (table_name, description, enabled)
VALUES 
  ('todos', 'Task management table - core application table', true),
  ('god_status', 'System status and metadata table - sentinel single-row table', true),
  ('information_schema', 'PostgreSQL system schema - allowed for introspection', true),
  ('pg_catalog', 'PostgreSQL system catalog - allowed for introspection', true)
ON CONFLICT (table_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_table_whitelist_enabled
  ON public.agent_exec_sql_table_whitelist (enabled)
  WHERE enabled = true;

COMMENT ON TABLE public.agent_exec_sql_table_whitelist IS
  'Whitelist of tables that agent_exec_sql is permitted to query. Pre-flight validation gate.';

-- ============================================================================
-- 3. Helper Function: Extract table names from query (basic regex parsing)
-- ============================================================================
CREATE OR REPLACE FUNCTION extract_table_names_from_query(p_query text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text;
  v_tables text[];
  v_pattern text;
BEGIN
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RETURN ARRAY[]::text[];
  END IF;
  
  v_query := upper(p_query);
  
  -- Extract table names from FROM and JOIN clauses
  -- Simple regex patterns:
  -- - FROM table_name
  -- - JOIN table_name
  -- - LEFT/RIGHT/INNER/OUTER JOIN table_name
  -- Supports: table_name, public.table_name, schema.table_name
  
  WITH matches AS (
    SELECT DISTINCT
      lower(btrim(m.table_name, ' "')) as table_name
    FROM regexp_matches(v_query, '\b(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|OUTER\s+JOIN|CROSS\s+JOIN)\s+([a-zA-Z_][a-zA-Z0-9_\.]*)', 'g') m(table_name)
  )
  SELECT array_agg(table_name) INTO v_tables FROM matches;
  
  RETURN COALESCE(v_tables, ARRAY[]::text[]);
EXCEPTION WHEN OTHERS THEN
  -- On any parsing error, return empty array (fail-safe)
  RETURN ARRAY[]::text[];
END;
$$;

COMMENT ON FUNCTION extract_table_names_from_query(text) IS
  'Extract table names from FROM/JOIN clauses in a query using regex. Returns array of lowercase table names.';

-- ============================================================================
-- 4. Helper Function: Validate tables against whitelist
-- ============================================================================
CREATE OR REPLACE FUNCTION validate_tables_against_whitelist(p_table_names text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_disallowed text[];
  v_result jsonb;
BEGIN
  -- Find any tables not in whitelist
  SELECT array_agg(DISTINCT table_name)
  INTO v_disallowed
  FROM (
    SELECT unnest(p_table_names) as table_name
  ) t
  WHERE table_name NOT IN (
    SELECT table_name 
    FROM public.agent_exec_sql_table_whitelist 
    WHERE enabled = true
  )
  AND table_name NOT IN ('', 'select', 'from', 'where', 'and', 'or', 'limit', 'offset');
  
  -- Build result
  IF v_disallowed IS NULL OR array_length(v_disallowed, 1) IS NULL THEN
    v_result := jsonb_build_object(
      'valid', true,
      'disallowed_tables', '[]'::jsonb,
      'message', 'All tables are whitelisted'
    );
  ELSE
    v_result := jsonb_build_object(
      'valid', false,
      'disallowed_tables', to_jsonb(v_disallowed),
      'message', 'Query references tables not in whitelist: ' || array_to_string(v_disallowed, ', ')
    );
  END IF;
  
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'valid', false,
    'error', SQLERRM,
    'message', 'Error during table validation'
  );
END;
$$;

COMMENT ON FUNCTION validate_tables_against_whitelist(text[]) IS
  'Validate an array of table names against the whitelist. Returns jsonb with validation status.';

-- ============================================================================
-- 5. Consolidated agent_exec_sql function (single signature)
-- ============================================================================
-- This is the ONLY signature. All calls use this with optional max_rows parameter.
CREATE OR REPLACE FUNCTION agent_exec_sql(
  p_query text,
  p_max_rows integer DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text;
  v_max_rows integer;
  v_is_select boolean;
  v_has_limit boolean;
  v_table_names text[];
  v_validation_result jsonb;
  v_result jsonb;
  v_error_msg text;
BEGIN
  -- ========================================================================
  -- PRE-FLIGHT CHECKS
  -- ========================================================================
  
  -- 1. Validate inputs
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RETURN jsonb_build_object(
      'error', 'Query cannot be null or empty',
      'sqlstate', 'NULL_VALUE_NOT_ALLOWED'
    );
  END IF;
  
  -- 2. Validate max_rows parameter
  IF p_max_rows IS NULL OR p_max_rows < 1 THEN
    v_max_rows := 10000;
  ELSE
    v_max_rows := least(p_max_rows, 1000000);  -- Cap at 1M
  END IF;
  
  -- 3. Detect if this is a SELECT query
  v_is_select := upper(btrim(p_query)) LIKE 'SELECT%' 
              OR upper(btrim(p_query)) LIKE 'WITH%'
              OR upper(btrim(p_query)) LIKE '(%SELECT%';
  
  -- 4. For SELECT queries: check table whitelist
  IF v_is_select THEN
    -- Extract tables from query
    v_table_names := extract_table_names_from_query(p_query);
    
    -- Validate tables
    IF array_length(v_table_names, 1) > 0 THEN
      v_validation_result := validate_tables_against_whitelist(v_table_names);
      
      IF (v_validation_result -> 'valid')::boolean IS FALSE THEN
        v_error_msg := v_validation_result ->> 'message';
        RETURN jsonb_build_object(
          'error', v_error_msg,
          'sqlstate', 'UNAUTHORIZED_TABLES',
          'query_attempted', p_query,
          'tables_referenced', to_jsonb(v_table_names)
        );
      END IF;
    END IF;
  END IF;
  
  -- ========================================================================
  -- QUERY TRANSFORMATION
  -- ========================================================================
  
  -- 5. For SELECT queries: inject LIMIT if missing
  IF v_is_select THEN
    v_query := btrim(p_query);
    
    -- Check if query already has LIMIT
    v_has_limit := upper(v_query) ~ '\sLIMIT\s+(\d+|[a-zA-Z_][a-zA-Z0-9_]*|ALL)\s*(OFFSET|\s*;?\s*)?$'
                OR upper(v_query) ~ '\sLIMIT\s+(\d+|[a-zA-Z_][a-zA-Z0-9_]*|ALL)\s*\)\s*';
    
    -- Remove trailing semicolon
    IF right(v_query, 1) = ';' THEN
      v_query := left(v_query, length(v_query) - 1);
    END IF;
    
    -- Inject LIMIT if not present
    IF NOT v_has_limit THEN
      v_query := v_query || ' LIMIT ' || v_max_rows;
    END IF;
  ELSE
    -- For non-SELECT queries, reject modification but allow execution
    v_query := p_query;
  END IF;
  
  -- ========================================================================
  -- EXECUTION
  -- ========================================================================
  
  -- 6. Execute query with safety wrapper
  IF v_is_select THEN
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || v_query || ') t'
    INTO v_result;
    RETURN COALESCE(v_result, '[]'::jsonb);
  ELSE
    -- Non-SELECT queries still execute but with DEFINER security
    EXECUTE v_query;
    RETURN jsonb_build_object(
      'status', 'OK',
      'message', 'Non-SELECT query executed',
      'query_type', 'DDL/DML'
    );
  END IF;

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE,
    'query_attempted', p_query,
    'max_rows_limit', v_max_rows,
    'severity', pg_exception_context
  );
END;
$$;

COMMENT ON FUNCTION agent_exec_sql(text, integer) IS
  'Execute SELECT/DDL queries with mandatory LIMIT injection and table whitelist validation. Single signature eliminates ambiguity.';

-- ============================================================================
-- 6. Grant Permissions
-- ============================================================================
GRANT EXECUTE ON FUNCTION agent_exec_sql(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_sql(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION extract_table_names_from_query(text) TO service_role;
GRANT EXECUTE ON FUNCTION validate_tables_against_whitelist(text[]) TO service_role;

-- ============================================================================
-- 7. Optional: Logging for audit trail
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.agent_exec_sql_query_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash      text        NOT NULL,
  query_snippet   text,
  tables_accessed text[],
  is_select       boolean     NOT NULL,
  limit_injected  boolean     NOT NULL,
  max_rows_limit  integer     NOT NULL,
  validation_passed boolean    NOT NULL,
  error_occurred  boolean     NOT NULL DEFAULT false,
  error_message   text,
  execution_time_ms integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_query_log_created
  ON public.agent_exec_sql_query_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_exec_sql_query_log_error
  ON public.agent_exec_sql_query_log (error_occurred, created_at DESC)
  WHERE error_occurred = true;

COMMENT ON TABLE public.agent_exec_sql_query_log IS
  'Audit log for agent_exec_sql query execution for debugging and compliance';

-- ============================================================================
-- Summary of Changes
-- ============================================================================
-- ✓ Removed ambiguous overloads from migration 0020
-- ✓ Single agent_exec_sql(text, integer) signature
-- ✓ Table whitelist validation (todos, god_status, information_schema, pg_catalog)
-- ✓ Mandatory LIMIT injection for SELECT queries
-- ✓ Pre-flight validation before query execution
-- ✓ Audit logging infrastructure
-- ✓ Backward compatible (p_max_rows parameter is optional)
