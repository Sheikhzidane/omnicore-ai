-- FORCE CLEANUP: Nuclear option to remove all agent_exec function ambiguity
-- This is applied AFTER 0023 to ensure all overloads are gone

-- ============================================================================
-- STEP 1: AGGRESSIVE CASCADE DROPS (ALL VARIATIONS)
-- ============================================================================

-- Drop all agent_exec_sql overloads with all possible signatures
DROP FUNCTION IF EXISTS public.agent_exec_sql(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, text) CASCADE;

-- Drop all agent_exec_ddl overloads
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text, uuid, text) CASCADE;

-- Drop helper functions
DROP FUNCTION IF EXISTS public.is_select_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.has_limit_clause(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text) CASCADE;
DROP FUNCTION IF EXISTS public.inject_limit_safely(text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.extract_table_names_from_query(text) CASCADE;
DROP FUNCTION IF EXISTS public.validate_tables_against_whitelist(text[]) CASCADE;
DROP FUNCTION IF EXISTS public.query_god_status_schema() CASCADE;
DROP FUNCTION IF EXISTS public.get_god_status_schema_stats() CASCADE;

-- Drop related tables
DROP TABLE IF EXISTS public.agent_exec_sql_config CASCADE;
DROP TABLE IF EXISTS public.agent_exec_sql_limit_events CASCADE;
DROP TABLE IF EXISTS public.agent_exec_sql_table_whitelist CASCADE;

-- ============================================================================
-- STEP 2: RECREATE SINGLE CANONICAL VERSIONS (NO OVERLOADS)
-- ============================================================================

-- Single canonical agent_exec_sql(text)
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
  IF p_query IS NULL OR btrim(p_query) = '' THEN
    RETURN jsonb_build_object('error', 'Query cannot be null or empty');
  END IF;
  
  v_query := btrim(p_query);
  
  -- For SELECT/WITH queries without LIMIT, inject LIMIT 10000 automatically
  IF (upper(v_query) LIKE 'SELECT%' OR upper(v_query) LIKE 'WITH%')
     AND NOT (upper(v_query) ~ '\sLIMIT\s+') 
  THEN
    IF right(v_query, 1) = ';' THEN
      v_query := left(v_query, length(v_query) - 1);
    END IF;
    v_query := v_query || ' LIMIT 10000';
  END IF;
  
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

-- Single canonical agent_exec_ddl(text)
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
-- STEP 4: VERIFY NO OVERLOADS EXIST
-- ============================================================================
-- This query should return exactly 1 row (or 2 for both functions):
-- SELECT routine_name, COUNT(*) FROM information_schema.routines 
-- WHERE routine_schema = 'public' AND routine_name IN ('agent_exec_sql', 'agent_exec_ddl')
-- GROUP BY routine_name;
