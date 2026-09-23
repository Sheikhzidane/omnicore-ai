-- Add name and value columns to god_status table
-- Supports pre-validated schema context for bounded SELECT queries

ALTER TABLE public.god_status
ADD COLUMN IF NOT EXISTS name text DEFAULT 'system',
ADD COLUMN IF NOT EXISTS value text DEFAULT '';

-- Update existing row with sample data
UPDATE public.god_status
SET name = 'system', value = 'Awakening...'
WHERE id = 1;

-- Add comment documenting the schema
COMMENT ON TABLE public.god_status IS 
  'God status table with id (primary key), thought, name, value, and updated_at fields. Used for system-wide status tracking.';

COMMENT ON COLUMN public.god_status.name IS 
  'Status name/category field for organizational purposes';

COMMENT ON COLUMN public.god_status.value IS 
  'Status value field for storing string-based status information';
