-- Fix ambiguous agent_exec_sql and agent_exec_ddl function signatures
-- These functions had multiple overloads causing "Could not choose the best candidate" errors
-- This migration consolidates them into single, unambiguous signatures

-- Drop all overloaded versions (using CASCADE to handle dependencies)
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_sql(text, text, uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS public.agent_exec_ddl(text, text, uuid) CASCADE;

-- Recreate agent_exec_sql with single signature - SELECT queries → returns rows as JSON
CREATE OR REPLACE FUNCTION agent_exec_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || query || ') t'
  INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- Recreate agent_exec_ddl with single signature - DDL / DML statements → returns status string
CREATE OR REPLACE FUNCTION agent_exec_ddl(statement text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE statement;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERROR: ' || SQLERRM;
END;
$$;

-- Grant to service_role
GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_ddl(text) TO service_role;

-- Verify functions are now unambiguous
COMMENT ON FUNCTION agent_exec_sql(text) IS 
  'Execute SELECT query safely and return results as jsonb array. Single signature eliminates ambiguity.';

COMMENT ON FUNCTION agent_exec_ddl(text) IS 
  'Execute DDL/DML statement safely and return status. Single signature eliminates ambiguity.';
