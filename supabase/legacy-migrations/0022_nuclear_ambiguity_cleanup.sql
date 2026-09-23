-- NUCLEAR CLEANUP: Resolve all agent_exec_sql and agent_exec_ddl ambiguities
-- 
-- BACKGROUND:
-- Migrations 0004, 0015, 0020, and 0021 created conflicting function overloads:
--   - agent_exec_sql(text)
--   - agent_exec_sql(text, text, uuid, boolean)
--   - agent_exec_sql(text, text, uuid, integer)
--   - agent_exec_sql(text, integer)
--   - agent_exec_ddl(text)
--   - agent_exec_ddl(text, text, uuid)
--
-- The PostgreSQL planner cannot resolve which version to call, causing:
--   "Could not choose the best candidate function between..."
--
-- SOLUTION: 
-- Drop everything related to these functions and recreate a SINGLE canonical version.
-- This is the nuclear option: complete cleanup and rebuild.

-- ============================================================================
-- STEP 1: DROP ALL OVERLOADS (with CASCADE to handle dependencies)
-- ============================================================================
-- Using CASCADE because helper functions and tables may depend on these
DROP FUNCTION IF EXISTS public.agent_exec_sql(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, integer) CASCADE;

DROP FUNCTION IF EXISTS public.agent_exec_ddl(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text, uuid) CASCADE;

-- Drop helper functions that may have been created by earlier migrations
DROP FUNCTION IF EXISTS public.is_select_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.has_limit_clause(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.extract_table_names_from_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.validate_tables_against_whitelist(text[]) CASCADE;

-- ============================================================================
-- STEP 2: RECREATE CANONICAL VERSIONS (single signature each)
-- ============================================================================

-- Canonical agent_exec_sql: Execute SELECT queries safely
CREATE OR REPLACE FUNCTION agent_exec_sql(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  v_query text;
BEGIN
  -- Input validation
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RETURN jsonb_build_object('error', 'Query cannot be null or empty');
  END IF;
  
  -- Trim and prepare query
  v_query := btrim(p_query);
  
  -- For SELECT queries without LIMIT, inject LIMIT 10000 (safety bound)
  IF (upper(v_query) LIKE 'SELECT%' OR upper(v_query) LIKE 'WITH%')
     AND NOT (upper(v_query) ~ '\sLIMIT\s+') 
  THEN
    -- Remove trailing semicolon if present
    IF right(v_query, 1) = ';' THEN
      v_query := left(v_query, length(v_query) - 1);
    END IF;
    v_query := v_query || ' LIMIT 10000';
  END IF;
  
  -- Execute query and aggregate results as JSON
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || v_query || ') t'
  INTO result;
  
  RETURN COALESCE(result, '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE,
    'query_attempted', p_query
  );
END;
$$;

COMMENT ON FUNCTION agent_exec_sql(text) IS 
  'Execute SELECT query safely with automatic LIMIT injection for unbound queries. Returns results as jsonb array. THIS IS THE CANONICAL VERSION — all other overloads have been dropped.';

-- Canonical agent_exec_ddl: Execute DDL/DML statements safely
CREATE OR REPLACE FUNCTION agent_exec_ddl(p_statement text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_statement IS NULL OR btrim(p_statement) = '' THEN
    RETURN 'ERROR: Statement cannot be null or empty';
  END IF;
  
  EXECUTE p_statement;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERROR: ' || SQLERRM || ' [SQLSTATE: ' || SQLSTATE || ']';
END;
$$;

COMMENT ON FUNCTION agent_exec_ddl(text) IS 
  'Execute DDL/DML statement safely and return status. THIS IS THE CANONICAL VERSION — all other overloads have been dropped.';

-- ============================================================================
-- STEP 3: GRANT PERMISSIONS
-- ============================================================================
GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO authenticated;
GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO anon;

GRANT EXECUTE ON FUNCTION agent_exec_ddl(text) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_ddl(text) TO authenticated;
GRANT EXECUTE ON FUNCTION agent_exec_ddl(text) TO anon;

-- ============================================================================
-- STEP 4: VERIFICATION
-- ============================================================================
-- After this migration, the following query should succeed:
--   SELECT agent_exec_sql('SELECT id, title FROM todos LIMIT 10');
-- 
-- If you still get "Could not choose the best candidate function",
-- then the CASCADE drops did not work (check for remaining functions).

-- Optional: Drop helper tables if no longer needed
-- DROP TABLE IF EXISTS public.agent_exec_sql_limit_events;
-- DROP TABLE IF EXISTS public.agent_exec_sql_config;
-- DROP TABLE IF EXISTS public.agent_exec_sql_table_whitelist;
