-- ============================================================
-- 1. Create the todos table
-- ============================================================
create table if not exists public.todos (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  status         text not null default 'pending'
                   check (status in ('pending','in_progress','completed','failed','blocked')),
  priority       text not null default 'medium'
                   check (priority in ('low','medium','high','critical')),
  assigned_agent text,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 2. Auto-update updated_at on every write
-- ============================================================
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger todos_updated_at
  before update on public.todos
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- 3. Row Level Security
--    Required for Supabase Realtime to deliver events to
--    subscribers. Without a matching SELECT policy, change
--    events are silently suppressed.
-- ============================================================
alter table public.todos enable row level security;

-- Open policies for demo (scope to auth.uid() in production)
create policy "anon_select" on public.todos
  for select to anon using (true);

create policy "anon_insert" on public.todos
  for insert to anon with check (true);

create policy "anon_update" on public.todos
  for update to anon using (true) with check (true);

create policy "anon_delete" on public.todos
  for delete to anon using (true);

-- ============================================================
-- 4. Enable Realtime
--    Adds this table to the supabase_realtime publication so
--    postgres_changes WebSocket events are emitted on every
--    INSERT / UPDATE / DELETE.
-- ============================================================
alter publication supabase_realtime add table public.todos;

-- ============================================================
-- 5. Replica Identity Full
--    Makes UPDATE/DELETE payloads include the complete old row,
--    not just the primary key. Required if you ever need to
--    compare old vs. new values in your subscription callback.
-- ============================================================
alter table public.todos replica identity full;

-- ============================================================
-- 6. Seed data (optional — delete if not wanted)
-- ============================================================
insert into public.todos (title, status, priority, assigned_agent) values
  ('Scrape product catalogue',  'completed',   'high',     'agent-scraper-1'),
  ('Summarise Q1 reports',      'in_progress', 'critical', 'agent-analyst-2'),
  ('Send follow-up emails',     'pending',     'medium',   null),
  ('Generate weekly digest',    'pending',     'low',      null),
  ('Index new knowledge base',  'failed',      'high',     'agent-indexer-1'),
  ('Review PR #42',             'blocked',     'medium',   'agent-reviewer-3');
