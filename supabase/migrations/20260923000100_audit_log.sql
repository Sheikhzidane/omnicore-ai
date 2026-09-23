-- ============================================================================
-- Append-only audit log for security-relevant actions (agent control, task
-- approval, publishing, credential changes, policy overrides, sign-in events).
--
-- Written ONLY by server code using the service role (lib/audit.ts), with the
-- actor derived from the verified session. Members may read their workspace's
-- entries; platform-level entries (workspace_id is null) are visible to
-- platform admins. Nobody can update or delete rows through the API.
-- ============================================================================

do $$ begin
  if to_regclass('public.audit_log') is not null then
    raise exception 'Preflight: public.audit_log already exists. See supabase/migrations/README.md.';
  end if;
end $$;

create table public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  actor_type   text not null check (actor_type in ('user','agent','system')),
  actor_id     text,
  action       text not null check (length(action) between 1 and 100),
  entity_type  text,
  entity_id    text,
  outcome      text not null default 'success' check (outcome in ('success','denied','error')),
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_workspace_created_idx on public.audit_log(workspace_id, created_at desc);
create index audit_log_action_idx on public.audit_log(action);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

create policy audit_log_select on public.audit_log for select to authenticated
  using (
    (workspace_id is not null and (select private.is_workspace_member(workspace_id, 'viewer')))
    or (workspace_id is null and (select private.is_platform_admin()))
  );

-- Belt and braces: even the service role cannot rewrite history.
create or replace function private.audit_log_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();
