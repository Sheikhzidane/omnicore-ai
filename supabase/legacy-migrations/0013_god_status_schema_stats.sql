-- God Status Schema and Statistics Query Function
-- Provides schema information and row count statistics for the god_status table

CREATE OR REPLACE FUNCTION get_god_status_schema_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Get schema information and row count statistics
  SELECT jsonb_build_object(
    'table_name', 'god_status',
    'row_count', (SELECT COUNT(*) FROM god_status),
    'columns', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'column_name', column_name,
          'data_type', data_type,
          'is_nullable', is_nullable,
          'column_default', column_default
        )
      )
      FROM information_schema.columns
      WHERE table_name = 'god_status'
      AND table_schema = 'public'
    ),
    'sample_data', (
      SELECT jsonb_agg(row_to_json(t))
      FROM (SELECT * FROM god_status LIMIT 1) t
    ),
    'storage_size', pg_size_pretty(pg_total_relation_size('god_status')),
    'indexes', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'index_name', indexname,
          'index_definition', indexdef
        )
      )
      FROM pg_indexes
      WHERE tablename = 'god_status'
    ),
    'schema_info', jsonb_build_object(
      'created_at', pg_stat_file('pg_class'::text),
      'total_relation_size_bytes', pg_total_relation_size('god_status')
    )
  ) INTO result;
  
  RETURN COALESCE(result, '{}'::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- Grant execute permission to service_role
GRANT EXECUTE ON FUNCTION get_god_status_schema_stats() TO service_role;

-- Create wrapper for agent_exec_sql compatibility
CREATE OR REPLACE FUNCTION query_god_status_schema()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN get_god_status_schema_stats();
END;
$$;

GRANT EXECUTE ON FUNCTION query_god_status_schema() TO service_role;

-- Support direct agent_exec_sql() calls with god_status queries
-- Example: SELECT agent_exec_sql('SELECT id, thought, updated_at FROM god_status')
COMMENT ON FUNCTION get_god_status_schema_stats() IS 
  'Returns complete schema and statistics for god_status table including row count, columns, sample data, indexes, and size information.';

COMMENT ON FUNCTION query_god_status_schema() IS 
  'Wrapper function for agent_exec_sql compatibility - returns god_status schema and statistics.';
