-- ============================================================================
-- Legacy ops baseline.
--
-- The inherited Pantheon migration chain (now in supabase/legacy-migrations/,
-- preserved unchanged) cannot be applied to a fresh project: 14 of 32 files
-- fail (invalid SQL, a non-existent function, tables that only existed in the
-- original author's database). This migration recreates ONLY the legacy
-- objects the application still uses — the /ops dashboard tables — with safe
-- access control.
--
-- Deliberately NOT recreated:
--   * agent_exec_sql / agent_exec_ddl — SECURITY DEFINER functions that ran
--     arbitrary SQL/DDL for the self-modifying agents (Phase 1 decision #3).
--   * the ~30 analysis/observability tables and RPCs no app code reads.
--   * all `to anon using (true)` policies.
--
-- Access: platform admins only (the /ops operators). The service role (used by
-- the legacy agent scripts and server routes) bypasses RLS as before.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.todos','public.god_status','public.traces','public.subscribers'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. This baseline is for fresh projects; see supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── todos: legacy ops task queue ─────────────────────────────────────────────
create table public.todos (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (length(title) between 1 and 500),
  description    text,
  status         text not null default 'proposed'
                   check (status in ('proposed','pending','in_progress','completed','failed','blocked','vetoed')),
  priority       text not null default 'medium' check (priority in ('low','medium','high','critical')),
  assigned_agent text,
  is_boss        boolean not null default false,
  deadline       timestamptz,
  comments       jsonb not null default '[]'::jsonb,
  retry_count    integer not null default 0,
  metadata       jsonb,
  parent_task_id uuid references public.todos(id) on delete set null,
  task_category  text not null default 'other' check (task_category in ('db','ui','infra','analysis','other')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on column public.todos.status is
  'Defaults to proposed: new tasks require human approval (Task Inbox) before agents may execute them.';
create index todos_status_priority_idx on public.todos(status, priority);
create index todos_parent_task_id_idx on public.todos(parent_task_id);
create index todos_created_at_idx on public.todos(created_at desc);
create trigger todos_updated_at before update on public.todos
  for each row execute function private.set_updated_at();
alter table public.todos replica identity full;

-- ── god_status: single-row orchestrator status ───────────────────────────────
create table public.god_status (
  id         integer primary key default 1 check (id = 1),
  thought    text,
  meta       jsonb,
  intent     jsonb,
  updated_at timestamptz not null default now()
);
insert into public.god_status (id, thought) values (1, 'Ops agents disabled') on conflict do nothing;

-- ── traces: per-tool-call log from the legacy agent runner ───────────────────
create table public.traces (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid references public.todos(id) on delete cascade,
  agent_name     text,
  tool_name      text not null,
  input_summary  text,
  result_summary text,
  duration_ms    integer,
  is_error       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index traces_task_id_created_idx on public.traces(task_id, created_at);

-- ── subscribers: newsletter signups (legacy marketing) ───────────────────────
create table public.subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 320),
  source          text default 'unknown',
  referrer        text,
  confirmed       boolean not null default false,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now()
);
create unique index subscribers_email_lower_idx on public.subscribers(lower(email));
create index subscribers_created_at_idx on public.subscribers(created_at desc);

-- ── RLS: platform admins only; nothing for anon ──────────────────────────────
alter table public.todos       enable row level security;
alter table public.god_status  enable row level security;
alter table public.traces      enable row level security;
alter table public.subscribers enable row level security;

revoke all on public.todos, public.god_status, public.traces, public.subscribers from anon;

-- Read-only for clients. Every write (create/approve/retry/delete) goes
-- through /api/todos, which re-verifies the platform admin server-side and
-- writes audit_log first. Agents write with the service role.
revoke insert, update, delete, truncate on public.todos, public.god_status, public.traces, public.subscribers from authenticated;
create policy todos_ops_admin_read on public.todos for select to authenticated
  using ((select private.is_platform_admin()));
create policy god_status_ops_admin_read on public.god_status for select to authenticated
  using ((select private.is_platform_admin()));
create policy traces_ops_admin_read on public.traces for select to authenticated
  using ((select private.is_platform_admin()));
create policy subscribers_ops_admin_read on public.subscribers for select to authenticated
  using ((select private.is_platform_admin()));
-- Public newsletter signups go through /api/subscribe (server-side, validated,
-- rate-limited, service role) — there is no anonymous insert policy.

-- Realtime for the /ops dashboard (delivered only to rows the subscriber can
-- SELECT under the policies above).
alter publication supabase_realtime add table public.todos, public.god_status, public.traces;
