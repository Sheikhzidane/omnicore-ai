-- ============================================================================
-- Character identity: profiles, visual rules, brand rules, memories, assets.
--
-- Character identity is split so AI output stays consistent over time:
--   character_profiles      — who the character is (1:1)
--   character_visual_rules  — how the character looks (1:1)
--   character_brand_rules   — do/don't rules, voice, topics (many)
--   character_memories      — canon facts/continuity (many; agent-proposed
--                             memories are NOT canon until a human confirms)
--   character_assets        — files in private Storage (metadata only)
--
-- Access model (same as Phase 1): members read via RLS; ALL writes are
-- server-only (service role, after requireWorkspace() + audit_log).
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.character_profiles','public.character_visual_rules','public.character_brand_rules',
                           'public.character_memories','public.character_assets'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── Reusable RLS helper ─────────────────────────────────────────────────────
-- Applies the standard workspace model to a table: RLS on, nothing for anon,
-- read for workspace members (viewer+), no client writes. Used by every
-- product migration from here on so the model can't drift table to table.
create or replace function private.apply_workspace_rls(tbl regclass)
returns void language plpgsql set search_path = '' as $$
declare pol text := replace(tbl::text, 'public.', '') || '_member_read';
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('revoke all on %s from anon', tbl);
  execute format('revoke insert, update, delete, truncate on %s from authenticated', tbl);
  execute format(
    'create policy %I on %s for select to authenticated using ((select private.is_workspace_member(workspace_id, %L)))',
    pol, tbl, 'viewer');
end;
$$;
revoke all on function private.apply_workspace_rls(regclass) from public;

-- Safe uuid cast used by storage policies (a malformed folder name must not
-- raise inside a policy).
create or replace function private.try_uuid(v text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return v::uuid;
exception when others then
  return null;
end;
$$;
grant execute on function private.try_uuid(text) to authenticated, service_role;

-- ── character_profiles (1:1) ────────────────────────────────────────────────
create table public.character_profiles (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  character_id          uuid not null,
  display_name          text not null check (length(trim(display_name)) between 1 and 80),
  description           text check (length(description) <= 2000),
  niche                 text check (length(niche) <= 120),
  target_audience       text check (length(target_audience) <= 1000),
  personality           jsonb not null default '{}'::jsonb,   -- traits, values, quirks (validated in lib/characters/schema.ts)
  tone_of_voice         text check (length(tone_of_voice) <= 1000),
  backstory             text check (length(backstory) <= 5000),
  content_boundaries    jsonb not null default '{}'::jsonb,   -- topics to avoid, sensitivity limits
  platform_strategy     jsonb not null default '{}'::jsonb,   -- per-platform goals/cadence
  monetisation_strategy jsonb not null default '{}'::jsonb,
  language              text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  version               integer not null default 1 check (version >= 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (character_id),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index character_profiles_workspace_idx on public.character_profiles(workspace_id);
create trigger character_profiles_updated_at before update on public.character_profiles
  for each row execute function private.set_updated_at();

-- ── character_visual_rules (1:1) ────────────────────────────────────────────
create table public.character_visual_rules (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  character_id           uuid not null,
  appearance_description text check (length(appearance_description) <= 4000),
  style_keywords         text[] not null default '{}' check (cardinality(style_keywords) <= 50),
  color_palette          text[] not null default '{}' check (cardinality(color_palette) <= 20),
  camera_style           text check (length(camera_style) <= 500),
  prompt_prefix          text check (length(prompt_prefix) <= 2000),
  negative_prompt        text check (length(negative_prompt) <= 2000),
  do_not_depict          text[] not null default '{}' check (cardinality(do_not_depict) <= 50),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (character_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index character_visual_rules_workspace_idx on public.character_visual_rules(workspace_id);
create trigger character_visual_rules_updated_at before update on public.character_visual_rules
  for each row execute function private.set_updated_at();

-- ── character_brand_rules (many) ────────────────────────────────────────────
create table public.character_brand_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid not null,
  rule_type    text not null check (rule_type in ('do','dont','voice','topic_allowed','topic_blocked','hashtag','cta','brand_safety')),
  rule         text not null check (length(trim(rule)) between 1 and 500),
  priority     smallint not null default 3 check (priority between 1 and 5),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index character_brand_rules_character_idx on public.character_brand_rules(character_id, active);
create index character_brand_rules_workspace_idx on public.character_brand_rules(workspace_id);
create trigger character_brand_rules_updated_at before update on public.character_brand_rules
  for each row execute function private.set_updated_at();

-- ── character_memories (many) ───────────────────────────────────────────────
create table public.character_memories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid not null,
  kind         text not null check (kind in ('fact','preference','event','relationship','catchphrase','continuity')),
  content      text not null check (length(trim(content)) between 1 and 2000),
  importance   smallint not null default 3 check (importance between 1 and 5),
  source       text not null default 'owner' check (source in ('owner','agent','content')),
  source_ref   text,
  -- Canon memories shape future generation. Only a human can make a memory
  -- canon; agent-proposed memories stay non-canon until confirmed.
  is_canon     boolean not null default false,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  agent_run_id uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id),
  constraint character_memories_canon_confirmed check (not is_canon or source = 'owner' or confirmed_by is not null)
);
create index character_memories_character_idx on public.character_memories(character_id, is_canon, importance desc);
create index character_memories_workspace_idx on public.character_memories(workspace_id);
create trigger character_memories_updated_at before update on public.character_memories
  for each row execute function private.set_updated_at();

-- ── character_assets (Storage metadata) ─────────────────────────────────────
create table public.character_assets (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  character_id          uuid not null,
  kind                  text not null check (kind in ('avatar','reference_image','style_guide','voice_sample','logo','consent_evidence','other')),
  storage_bucket        text not null check (storage_bucket in ('character-assets','reference-images')),
  storage_path          text not null,
  file_name             text not null check (length(file_name) between 1 and 255),
  mime_type             text not null check (length(mime_type) <= 100),
  bytes                 bigint not null check (bytes > 0),
  width                 integer check (width > 0),
  height                integer check (height > 0),
  sha256                text check (sha256 ~ '^[a-f0-9]{64}$'),
  provenance            text not null check (provenance in ('owned','licensed','ai_generated')),
  rights_notes          text check (length(rights_notes) <= 1000),
  depicts_real_person   boolean not null default false,
  consent_evidence_path text,
  is_primary            boolean not null default false,
  status                text not null default 'pending_upload' check (status in ('pending_upload','ready','deleted')),
  uploaded_by           uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (storage_bucket, storage_path),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  -- Objects must live under <workspace_id>/<character_id>/ so storage
  -- policies and ownership checks can rely on the path.
  constraint character_assets_path_owned check (
    storage_path like workspace_id::text || '/' || character_id::text || '/%'
    and storage_path !~ '(^|/)\.\.(/|$)'
  ),
  constraint character_assets_real_person_consent check (not depicts_real_person or consent_evidence_path is not null)
);
create index character_assets_character_idx on public.character_assets(character_id, kind);
create index character_assets_workspace_idx on public.character_assets(workspace_id);
create unique index character_assets_one_primary_avatar on public.character_assets(character_id) where is_primary and kind = 'avatar' and status <> 'deleted';
create trigger character_assets_updated_at before update on public.character_assets
  for each row execute function private.set_updated_at();

select private.apply_workspace_rls('public.character_profiles');
select private.apply_workspace_rls('public.character_visual_rules');
select private.apply_workspace_rls('public.character_brand_rules');
select private.apply_workspace_rls('public.character_memories');
select private.apply_workspace_rls('public.character_assets');
