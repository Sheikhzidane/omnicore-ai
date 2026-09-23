-- ============================================================
-- Add parent_task_id and task_category to todos
-- ============================================================

ALTER TABLE public.todos
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES public.todos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_category  TEXT NOT NULL DEFAULT 'other'
    CHECK (task_category IN ('db', 'ui', 'infra', 'analysis', 'other'));

CREATE INDEX IF NOT EXISTS idx_todos_parent_task_id ON public.todos(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_todos_task_category  ON public.todos(task_category);
