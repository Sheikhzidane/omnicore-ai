-- Create partial index on pending tasks for efficient agent priority queue queries
-- This index optimizes queries filtering by assigned_agent and status = 'pending'
-- The index also includes priority and created_at for optimal ordering
CREATE INDEX IF NOT EXISTS idx_todos_pending_status ON todos(assigned_agent, priority, created_at) 
WHERE status = 'pending';

-- Create RPC function to get agent priority queue
-- This function returns all pending tasks assigned to a specific agent
-- ordered by priority (high > medium > low) and then by creation time (oldest first)
CREATE OR REPLACE FUNCTION get_agent_priority_queue(
  agent_id TEXT,
  limit_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  status TEXT,
  priority TEXT,
  assigned_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  description TEXT,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    todos.id,
    todos.title,
    todos.status,
    todos.priority,
    todos.assigned_agent,
    todos.created_at,
    todos.updated_at,
    todos.description,
    todos.metadata
  FROM todos
  WHERE 
    todos.assigned_agent = agent_id
    AND todos.status = 'pending'
  ORDER BY 
    CASE 
      WHEN todos.priority = 'high' THEN 1
      WHEN todos.priority = 'medium' THEN 2
      WHEN todos.priority = 'low' THEN 3
      ELSE 4
    END,
    todos.created_at ASC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql STABLE;
