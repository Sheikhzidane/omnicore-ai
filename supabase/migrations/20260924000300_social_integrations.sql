-- ============================================================================
-- Social accounts, credential storage, publishing policies, integrations,
-- inbound webhook log.
--
-- TOKENS NEVER LIVE IN A NORMAL COLUMN:
--   social_credentials_metadata  — non-secret facts (scopes, expiry, key version)
--   private.social_credential_secrets — AES-256-GCM ciphertext produced by the
--     app (lib/secrets/credentials.ts), in the non-exposed `private` schema,
--     reachable only through service-role-only functions below. A database
--     leak alone does not reveal tokens (the key is an app secret).
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.social_accounts','public.social_credentials_metadata','private.social_credential_secrets',
                           'public.publishing_policies','public.integration_connections','public.webhook_events'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── social_accounts ─────────────────────────────────────────────────────────
-- `platform` is extensible (any registered provider id in lib/social/registry).
create table public.social_accounts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  platform            text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  handle              text check (length(handle) <= 100),
  display_name        text check (length(display_name) <= 200),
  external_account_id text check (length(external_account_id) <= 200),
  status              text not null default 'disconnected'
                        check (status in ('disconnected','pending','connected','error','revoked')),
  scopes              text[] not null default '{}',
  connected_at        timestamptz,
  last_synced_at      timestamptz,
  last_error          text check (length(last_error) <= 1000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (character_id, platform),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  constraint social_accounts_connected_has_identity check (status <> 'connected' or (external_account_id is not null and connected_at is not null))
);
create unique index social_accounts_external_idx on public.social_accounts(platform, external_account_id) where external_account_id is not null;
create index social_accounts_workspace_idx on public.social_accounts(workspace_id, status);
create trigger social_accounts_updated_at before update on public.social_accounts
  for each row execute function private.set_updated_at();

-- ── social_credentials_metadata (NO secrets) ────────────────────────────────
create table public.social_credentials_metadata (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  social_account_id  uuid not null,
  token_type         text not null default 'oauth2' check (token_type in ('oauth2','oauth1','api_key')),
  scopes             text[] not null default '{}',
  expires_at         timestamptz,
  refresh_expires_at timestamptz,
  key_version        text not null default 'v1' check (key_version ~ '^v[0-9]+$'),
  last_refreshed_at  timestamptz,
  status             text not null default 'valid' check (status in ('valid','expired','revoked','refresh_failed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (social_account_id),
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade
);
create index social_credentials_metadata_workspace_idx on public.social_credentials_metadata(workspace_id);
create trigger social_credentials_metadata_updated_at before update on public.social_credentials_metadata
  for each row execute function private.set_updated_at();

-- ── private.social_credential_secrets (ciphertext only) ─────────────────────
create table private.social_credential_secrets (
  social_account_id uuid primary key references public.social_accounts(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  -- Envelope from lib/secrets/credentials.ts: v1.<iv>.<tag>.<ciphertext>
  ciphertext        text not null check (ciphertext ~ '^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  created_at        timestamptz not null default now(),
  rotated_at        timestamptz
);
alter table private.social_credential_secrets enable row level security;
revoke all on private.social_credential_secrets from public, anon, authenticated;

create or replace function public.store_social_credential(p_social_account_id uuid, p_ciphertext text)
returns void language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.social_accounts where id = p_social_account_id;
  if ws is null then raise exception 'unknown social account'; end if;
  insert into private.social_credential_secrets (social_account_id, workspace_id, ciphertext)
  values (p_social_account_id, ws, p_ciphertext)
  on conflict (social_account_id) do update set ciphertext = excluded.ciphertext, rotated_at = now();
end;
$$;

create or replace function public.read_social_credential(p_social_account_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select ciphertext from private.social_credential_secrets where social_account_id = p_social_account_id
$$;

create or replace function public.delete_social_credential(p_social_account_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from private.social_credential_secrets where social_account_id = p_social_account_id
$$;

revoke all on function public.store_social_credential(uuid, text) from public, anon, authenticated;
revoke all on function public.read_social_credential(uuid) from public, anon, authenticated;
revoke all on function public.delete_social_credential(uuid) from public, anon, authenticated;
grant execute on function public.store_social_credential(uuid, text) to service_role;
grant execute on function public.read_social_credential(uuid) to service_role;
grant execute on function public.delete_social_credential(uuid) to service_role;

-- ── publishing_policies (was platform_publishing_policies) ──────────────────
-- Workspace-wide default per platform (character_id null) plus optional
-- per-character overrides. Defaults are the safe ones.
alter table public.platform_publishing_policies rename to publishing_policies;
alter table public.publishing_policies drop constraint platform_publishing_policies_platform_check;
alter table public.publishing_policies add constraint publishing_policies_platform_check check (platform ~ '^[a-z][a-z0-9_]{0,31}$');
alter table public.publishing_policies drop constraint platform_publishing_policies_workspace_id_platform_key;
alter table public.publishing_policies
  add column character_id uuid,
  add column auto_publish_allowed boolean not null default false,
  add constraint publishing_policies_character_fk foreign key (character_id, workspace_id)
    references public.characters(id, workspace_id) on delete cascade,
  -- Auto-publishing can only be allowed when human approval is not required.
  add constraint publishing_policies_auto_needs_no_human check (not auto_publish_allowed or not requires_human_approval);
create unique index publishing_policies_scope_idx on public.publishing_policies
  (workspace_id, platform, coalesce(character_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter policy platform_publishing_policies_select on public.publishing_policies rename to publishing_policies_select;
alter trigger platform_publishing_policies_updated_at on public.publishing_policies rename to publishing_policies_updated_at;

-- ── integration_connections (non-secret provider config/status) ─────────────
create table public.integration_connections (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  provider        text not null check (provider ~ '^[a-z][a-z0-9_]{0,40}$'),
  kind            text not null check (kind in ('ai_text','ai_image','ai_video','ai_moderation','ai_embeddings','payments','email','analytics','other')),
  status          text not null default 'not_configured' check (status in ('not_configured','configured','verified','error','disabled')),
  -- Non-secret settings only (model names, region…). Secrets stay in env vars.
  config          jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_error      text check (length(last_error) <= 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, provider, kind)
);
create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function private.set_updated_at();

-- ── webhook_events (inbound, idempotent) ────────────────────────────────────
create table public.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid references public.workspaces(id) on delete cascade,
  provider        text not null check (provider ~ '^[a-z][a-z0-9_]{0,40}$'),
  event_id        text not null check (length(event_id) between 1 and 200),
  event_type      text check (length(event_type) <= 100),
  signature_valid boolean not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error           text check (length(error) <= 1000),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  -- Replays of the same provider event are rejected by this key.
  unique (provider, event_id)
);
create index webhook_events_workspace_idx on public.webhook_events(workspace_id, received_at desc);

select private.apply_workspace_rls('public.social_accounts');
select private.apply_workspace_rls('public.social_credentials_metadata');
select private.apply_workspace_rls('public.integration_connections');

-- webhook_events may be platform-level (workspace_id null): custom policy.
alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon;
revoke insert, update, delete, truncate on public.webhook_events from authenticated;
create policy webhook_events_read on public.webhook_events for select to authenticated
  using (
    (workspace_id is not null and (select private.is_workspace_member(workspace_id, 'admin')))
    or (workspace_id is null and (select private.is_platform_admin()))
  );
