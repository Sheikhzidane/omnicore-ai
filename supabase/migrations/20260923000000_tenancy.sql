-- ============================================================================
-- Tenancy foundation: workspaces, members, platform admins, RLS helpers.
--
-- Security model (docs/SECURITY.md):
--   * Every product row carries workspace_id; RLS grants access by membership.
--   * Identity comes from auth.uid() (the verified JWT) — never from a
--     client-supplied owner_id / workspace_id.
--   * V1 is single-owner: each new auth user gets exactly one workspace in
--     which they are 'owner'. The schema already supports many members and
--     many workspaces per user.
--   * Helper functions live in the `private` schema, which PostgREST does not
--     expose, so they cannot be called directly by API clients.
-- ============================================================================

-- Refuse to run over pre-existing objects of the same name. The inherited
-- Pantheon project created tables at runtime; if any collide we stop rather
-- than let `create table if not exists` silently keep an unknown shape.
do $$
declare t text;
begin
  foreach t in array array['public.workspaces','public.workspace_members','private.platform_admins'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md (live-DB preflight).', t;
    end if;
  end loop;
end $$;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Shared trigger function for updated_at columns.
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── workspaces ───────────────────────────────────────────────────────────────
create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 120),
  owner_id   uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_owner_id_idx on public.workspaces(owner_id);
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();

-- ── workspace_members ────────────────────────────────────────────────────────
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner','admin','editor','viewer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members(user_id);
create trigger workspace_members_updated_at before update on public.workspace_members
  for each row execute function private.set_updated_at();

-- ── platform admins (operators of the /ops subsystem) ────────────────────────
-- Not exposed through the API. Populated server-side from OPS_ADMIN_EMAILS
-- (lib/auth/ops-admin.ts) or by SQL. Platform admin ≠ workspace owner.
create table private.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ── helpers ──────────────────────────────────────────────────────────────────
create or replace function private.role_rank(r text)
returns int language sql immutable set search_path = '' as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end
$$;

-- True when the calling user is a member of `ws` with at least `min_role`.
create or replace function private.is_workspace_member(ws uuid, min_role text default 'viewer')
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and private.role_rank(m.role) >= private.role_rank(min_role)
  )
$$;

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins a where a.user_id = (select auth.uid()))
$$;

revoke all on function private.is_workspace_member(uuid, text) from public;
revoke all on function private.is_platform_admin() from public;
grant execute on function private.is_workspace_member(uuid, text) to authenticated, service_role;
grant execute on function private.is_platform_admin() to authenticated, service_role;
grant execute on function private.role_rank(text) to authenticated, service_role;

-- Public wrapper so the app can ask "am I a platform admin?" — reveals only
-- the caller's own status.
create or replace function public.current_user_is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin()
$$;
revoke all on function public.current_user_is_platform_admin() from public, anon;
grant execute on function public.current_user_is_platform_admin() to authenticated, service_role;

-- ── new user → personal workspace (server-side; identity from auth.users) ────
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  insert into public.workspaces (name, owner_id)
  values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'My') || '''s workspace', new.id)
  returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table private.platform_admins  enable row level security;

revoke all on public.workspaces, public.workspace_members from anon;
revoke all on private.platform_admins from anon, authenticated;

create policy workspaces_select on public.workspaces for select to authenticated
  using ((select private.is_workspace_member(id, 'viewer')));
create policy workspaces_update on public.workspaces for update to authenticated
  using ((select private.is_workspace_member(id, 'admin')))
  with check ((select private.is_workspace_member(id, 'admin')));
-- No insert/delete policies: workspaces are created by the trigger above and
-- deleted only by the service role.

create policy members_select on public.workspace_members for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
-- Membership changes are owner-only and may not create/transfer ownership
-- from the client; ownership transfer is a server-side operation.
create policy members_insert on public.workspace_members for insert to authenticated
  with check ((select private.is_workspace_member(workspace_id, 'owner')) and role <> 'owner');
create policy members_update on public.workspace_members for update to authenticated
  using ((select private.is_workspace_member(workspace_id, 'owner')) and role <> 'owner')
  with check ((select private.is_workspace_member(workspace_id, 'owner')) and role <> 'owner');
create policy members_delete on public.workspace_members for delete to authenticated
  using ((select private.is_workspace_member(workspace_id, 'owner')) and role <> 'owner');
