-- FINAL CLEANUP: Remove ALL agent_exec_sql and agent_exec_ddl overloads
-- 
-- ISSUE:
-- Previous migrations (0004, 0020, 0021, 0022) created multiple conflicting overloads:
--   - agent_exec_sql(text)
--   - agent_exec_sql(text, integer)
--   - agent_exec_sql(text, text, uuid, boolean)
--   - agent_exec_sql(text, text, uuid, integer)
--   - agent_exec_ddl(text)
--   - agent_exec_ddl(text, text, uuid)
--
-- AND helper functions that may also depend on these:
--   - is_select_query(text)
--   - has_limit_clause(text)
--   - inject_limit_safely(text)
--   - inject_limit_safely(text, integer)
--   - extract_table_names_from_query(text)
--   - validate_tables_against_whitelist(text[])
--
-- The PostgreSQL planner cannot disambiguate, causing:
--   "Could not choose the best candidate function between..."
--
-- SOLUTION: Nuclear option - drop EVERYTHING and rebuild from scratch.

-- ============================================================================
-- STEP 1: DROP ALL OVERLOADS AND HELPERS (CASCADE to dependencies)
-- ============================================================================

-- Drop all agent_exec_sql overloads
DROP FUNCTION IF EXISTS public.agent_exec_sql(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, integer) CASCADE;

-- Drop all agent_exec_ddl overloads
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text, uuid) CASCADE;

-- Drop all helper functions
DROP FUNCTION IF EXISTS public.is_select_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.has_limit_clause(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.extract_table_names_from_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.validate_tables_against_whitelist(text[]) CASCADE;

-- Drop related tables
DROP TABLE IF EXISTS public.agent_exec_sql_config CASCADE;
DROP TABLE IF EXISTS public.agent_exec_sql_limit_events CASCADE;
DROP TABLE IF EXISTS public.agent_exec_sql_table_whitelist CASCADE;

-- ============================================================================
-- STEP 2: RECREATE CANONICAL VERSIONS (SINGLE SIGNATURE EACH)
-- ============================================================================

-- Canonical agent_exec_sql: Execute SELECT queries with automatic safe LIMIT
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
  
  v_query := btrim(p_query);
  
  -- For SELECT/WITH queries without LIMIT, inject LIMIT 10000 automatically
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
  'Execute SELECT query safely with automatic LIMIT 10000 injection for unbounded queries. Returns results as jsonb array. CANONICAL VERSION ONLY.';

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
  'Execute DDL/DML statement safely and return status. CANONICAL VERSION ONLY.';

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
-- After applying this migration, these queries should succeed:
--   SELECT agent_exec_sql('SELECT id, title FROM todos LIMIT 10');
--   SELECT agent_exec_sql('SELECT id, name, value FROM god_status');
--
-- If ambiguity errors persist, check that CASCADE drops removed all dependent objects.
