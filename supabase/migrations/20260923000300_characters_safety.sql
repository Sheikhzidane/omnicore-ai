-- ============================================================================
-- Safety foundations: characters (with AI-disclosure, approval and age
-- settings), content policies, and per-platform publishing policies.
--
-- Writes are SERVER-ONLY (service role, after requireWorkspaceRole() and with
-- an audit_log entry). Members get read access through RLS. This keeps every
-- change to a safety setting authorised and audited — a browser holding a
-- user JWT cannot flip a character to auto-publish or drop disclosure.
--
-- Hard rules encoded as constraints (not just UI):
--   * AI disclosure cannot be turned off (no 'none' mode).
--   * Sponsored-content disclosure cannot be turned off.
--   * Human approval is the default everywhere.
--   * Age-restricted characters must target 18+.
--   * A character depicting a real person requires recorded consent evidence.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.characters','public.content_policies','public.platform_publishing_policies'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── content_policies ─────────────────────────────────────────────────────────
create table public.content_policies (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),
  version      integer not null default 1 check (version >= 1),
  is_default   boolean not null default false,
  -- Validated by lib/safety/policy.ts (zod) before every write.
  rules        jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, workspace_id)
);
create index content_policies_workspace_idx on public.content_policies(workspace_id);
create unique index content_policies_one_default_idx on public.content_policies(workspace_id) where is_default;
create trigger content_policies_updated_at before update on public.content_policies
  for each row execute function private.set_updated_at();

-- ── characters ───────────────────────────────────────────────────────────────
create table public.characters (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id) on delete cascade,
  name                    text not null check (length(trim(name)) between 1 and 120),
  slug                    text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  status                  text not null default 'draft' check (status in ('draft','active','paused','archived')),
  -- AI disclosure: always on; modes only choose WHERE it appears.
  ai_disclosure_mode      text not null default 'always' check (ai_disclosure_mode in ('always','bio_and_posts','bio_only')),
  disclosure_text         text not null default 'AI-generated virtual character'
                            check (length(trim(disclosure_text)) between 3 and 200),
  -- Human approval by default; auto_low_risk still requires safety checks,
  -- a connected account and per-platform limits (lib/safety/approval.ts).
  approval_mode           text not null default 'human_required' check (approval_mode in ('human_required','auto_low_risk')),
  min_audience_age        integer not null default 13 check (min_audience_age between 13 and 21),
  age_restricted          boolean not null default false,
  depicts_real_person     boolean not null default false,
  consent_evidence_path   text,
  content_policy_id       uuid,
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (workspace_id, slug),
  unique (id, workspace_id),
  -- Composite FK: a character can only use a policy from its own workspace.
  foreign key (content_policy_id, workspace_id) references public.content_policies(id, workspace_id) on delete restrict,
  constraint characters_age_restricted_is_adult check (not age_restricted or min_audience_age >= 18),
  constraint characters_real_person_needs_consent check (not depicts_real_person or consent_evidence_path is not null)
);
create index characters_workspace_status_idx on public.characters(workspace_id, status);
create index characters_content_policy_idx on public.characters(content_policy_id);
create trigger characters_updated_at before update on public.characters
  for each row execute function private.set_updated_at();

-- ── platform_publishing_policies ─────────────────────────────────────────────
create table public.platform_publishing_policies (
  id                            uuid primary key default gen_random_uuid(),
  workspace_id                  uuid not null references public.workspaces(id) on delete cascade,
  platform                      text not null check (platform in ('instagram','tiktok','youtube','x')),
  publishing_enabled            boolean not null default false,
  requires_human_approval       boolean not null default true,
  max_posts_per_day             integer not null default 3 check (max_posts_per_day between 0 and 25),
  min_minutes_between_posts     integer not null default 60 check (min_minutes_between_posts >= 15),
  ai_label_required             boolean not null default true,
  sponsored_disclosure_required boolean not null default true check (sponsored_disclosure_required),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (workspace_id, platform)
);
create trigger platform_publishing_policies_updated_at before update on public.platform_publishing_policies
  for each row execute function private.set_updated_at();

-- ── RLS: members read; writes are server-only ────────────────────────────────
alter table public.content_policies             enable row level security;
alter table public.characters                   enable row level security;
alter table public.platform_publishing_policies enable row level security;

revoke all on public.content_policies, public.characters, public.platform_publishing_policies from anon;
revoke insert, update, delete, truncate on public.content_policies, public.characters, public.platform_publishing_policies from authenticated;

create policy content_policies_select on public.content_policies for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
create policy characters_select on public.characters for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
create policy platform_publishing_policies_select on public.platform_publishing_policies for select to authenticated
  using ((select private.is_workspace_member(workspace_id, 'viewer')));
