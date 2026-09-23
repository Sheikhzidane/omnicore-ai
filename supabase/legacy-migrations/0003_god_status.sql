-- God agent status table
create table if not exists public.god_status (
  id         integer primary key default 1,
  thought    text not null default 'Watching...',
  updated_at timestamptz not null default now()
);

-- Seed initial row
insert into public.god_status (id, thought) values (1, 'Awakening...')
  on conflict (id) do nothing;

-- Enable realtime
alter publication supabase_realtime add table public.god_status;
