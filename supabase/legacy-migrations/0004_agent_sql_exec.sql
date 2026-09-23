-- Agent SQL execution functions
-- Run these in Supabase SQL Editor

-- SELECT queries → returns rows as JSON
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

-- DDL / DML statements → returns status string
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

-- Grant to service role
GRANT EXECUTE ON FUNCTION agent_exec_sql(text) TO service_role;
GRANT EXECUTE ON FUNCTION agent_exec_ddl(text) TO service_role;
