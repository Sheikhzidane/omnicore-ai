-- ============================================================================
-- Content engine: campaigns, ideas, items, versions, assets, calendar,
-- publishing jobs + results.
--
-- Every content item is tied to workspace + character + platform, optionally a
-- campaign, the AI run that produced it, its approval and its publishing state.
--
-- Publishing safety is enforced in the database:
--   * a job can be queued only with an APPROVED approval, or an explicit
--     trusted-auto policy decision recorded on the job (auto_approved_reason)
--   * one live job per (content item, social account): no duplicate posts
--   * idempotency_key is unique per workspace
--   * claim_publishing_jobs() uses SKIP LOCKED so concurrent cron invocations
--     never double-publish; complete_publishing_job() records results and
--     applies exponential-backoff retries
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.campaigns','public.content_ideas','public.content_items','public.content_versions',
                           'public.content_assets','public.content_calendar','public.campaign_content',
                           'public.publishing_jobs','public.publishing_results'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── campaigns ───────────────────────────────────────────────────────────────
create table public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid,
  name         text not null check (length(trim(name)) between 1 and 200),
  objective    text check (length(objective) <= 2000),
  type         text not null default 'growth' check (type in ('growth','sponsorship','launch','affiliate','evergreen','other')),
  status       text not null default 'draft' check (status in ('draft','active','paused','completed','cancelled')),
  start_date   date,
  end_date     date,
  budget_cents bigint check (budget_cents >= 0),
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  constraint campaigns_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index campaigns_workspace_idx on public.campaigns(workspace_id, status);
create index campaigns_character_idx on public.campaigns(character_id);
create trigger campaigns_updated_at before update on public.campaigns for each row execute function private.set_updated_at();

-- ── content_ideas ───────────────────────────────────────────────────────────
create table public.content_ideas (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid not null,
  campaign_id  uuid,
  title        text not null check (length(trim(title)) between 1 and 300),
  summary      text check (length(summary) <= 4000),
  angle        text check (length(angle) <= 1000),
  platforms    text[] not null default '{}',
  source       text not null default 'owner' check (source in ('owner','agent')),
  agent_run_id uuid,
  status       text not null default 'new' check (status in ('new','accepted','rejected','converted')),
  score        numeric(4,1) check (score between 0 and 100),
  trend_refs   jsonb not null default '[]'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id)
);
create index content_ideas_character_idx on public.content_ideas(character_id, status);
create index content_ideas_workspace_idx on public.content_ideas(workspace_id, created_at desc);
create index content_ideas_campaign_idx on public.content_ideas(campaign_id);
create trigger content_ideas_updated_at before update on public.content_ideas for each row execute function private.set_updated_at();

-- ── content_items ───────────────────────────────────────────────────────────
create table public.content_items (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  character_id       uuid not null,
  campaign_id        uuid,
  idea_id            uuid,
  platform           text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  format             text not null check (format in ('post','carousel','reel','short','story','thread','video','live_script')),
  title              text not null check (length(trim(title)) between 1 and 300),
  status             text not null default 'draft' check (status in (
                       'draft','in_review','approved','rejected','scheduled','publishing','published','failed','archived')),
  current_version    integer not null default 0 check (current_version >= 0),
  is_sponsored       boolean not null default false,
  content_rating     text not null default 'general' check (content_rating in ('general','teen','mature')),
  safety_status      text not null default 'unchecked' check (safety_status in ('unchecked','passed','flagged','blocked')),
  safety_report      jsonb not null default '{}'::jsonb,
  disclosure_applied boolean not null default false,
  approval_id        uuid,
  agent_run_id       uuid,
  scheduled_for      timestamptz,
  timezone           text not null default 'UTC' check (length(timezone) between 1 and 64),
  published_at       timestamptz,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id),
  foreign key (idea_id, workspace_id) references public.content_ideas(id, workspace_id) on delete set null (idea_id),
  foreign key (approval_id, workspace_id) references public.agent_approvals(id, workspace_id) on delete set null (approval_id),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id),
  -- Nothing reaches approved/scheduled/published without passing safety,
  -- carrying disclosure, and a recorded approval.
  constraint content_items_release_gate check (
    status not in ('approved','scheduled','publishing','published')
    or (safety_status = 'passed' and disclosure_applied and approval_id is not null)
  )
);
create index content_items_character_idx on public.content_items(character_id, status);
create index content_items_workspace_idx on public.content_items(workspace_id, status, updated_at desc);
create index content_items_campaign_idx on public.content_items(campaign_id);
create index content_items_idea_idx on public.content_items(idea_id);
create index content_items_schedule_idx on public.content_items(scheduled_for) where status = 'scheduled';
create trigger content_items_updated_at before update on public.content_items for each row execute function private.set_updated_at();

-- ── content_versions (immutable history) ────────────────────────────────────
create table public.content_versions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  content_item_id uuid not null,
  version         integer not null check (version >= 1),
  caption         text check (length(caption) <= 10000),
  script          text check (length(script) <= 20000),
  hashtags        text[] not null default '{}' check (cardinality(hashtags) <= 60),
  image_prompt    text check (length(image_prompt) <= 4000),
  video_prompt    text check (length(video_prompt) <= 4000),
  metadata        jsonb not null default '{}'::jsonb,
  created_by_type text not null check (created_by_type in ('user','agent')),
  created_by      uuid references auth.users(id) on delete set null,
  agent_run_id    uuid,
  created_at      timestamptz not null default now(),
  unique (content_item_id, version),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade,
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id)
);
create index content_versions_workspace_idx on public.content_versions(workspace_id);
create or replace function private.content_versions_immutable() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'content_versions are immutable; create a new version instead'; end; $$;
create trigger content_versions_no_update before update on public.content_versions
  for each row execute function private.content_versions_immutable();

-- ── content_assets (generated / uploaded media; Storage metadata) ───────────
create table public.content_assets (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  content_item_id     uuid,
  kind                text not null check (kind in ('image','video','audio','thumbnail','document')),
  storage_bucket      text not null check (storage_bucket in ('generated-content','campaign-assets')),
  storage_path        text not null,
  mime_type           text not null check (length(mime_type) <= 100),
  bytes               bigint check (bytes > 0),
  width               integer check (width > 0),
  height              integer check (height > 0),
  duration_seconds    numeric(10,2) check (duration_seconds >= 0),
  provenance          text not null check (provenance in ('ai_generated','uploaded')),
  generation_provider text check (length(generation_provider) <= 60),
  prompt              text check (length(prompt) <= 4000),
  agent_run_id        uuid,
  status              text not null default 'pending' check (status in ('pending','ready','failed','deleted')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (storage_bucket, storage_path),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete set null (content_item_id),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id),
  constraint content_assets_path_owned check (storage_path like workspace_id::text || '/%' and storage_path !~ '(^|/)\.\.(/|$)')
);
create index content_assets_item_idx on public.content_assets(content_item_id);
create index content_assets_workspace_idx on public.content_assets(workspace_id, character_id);
create trigger content_assets_updated_at before update on public.content_assets for each row execute function private.set_updated_at();

-- ── content_calendar (planned slots) ────────────────────────────────────────
create table public.content_calendar (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  character_id    uuid not null,
  platform        text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  slot_date       date not null,
  slot_time       time,
  timezone        text not null default 'UTC',
  content_item_id uuid,
  note            text check (length(note) <= 1000),
  status          text not null default 'planned' check (status in ('planned','filled','skipped')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete set null (content_item_id)
);
create index content_calendar_range_idx on public.content_calendar(workspace_id, slot_date);
create index content_calendar_character_idx on public.content_calendar(character_id, slot_date);
create index content_calendar_item_idx on public.content_calendar(content_item_id);
create trigger content_calendar_updated_at before update on public.content_calendar for each row execute function private.set_updated_at();

-- ── campaign_content ────────────────────────────────────────────────────────
create table public.campaign_content (
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  campaign_id     uuid not null,
  content_item_id uuid not null,
  created_at      timestamptz not null default now(),
  primary key (campaign_id, content_item_id),
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete cascade,
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade
);
create index campaign_content_item_idx on public.campaign_content(content_item_id);
create index campaign_content_workspace_idx on public.campaign_content(workspace_id);

-- ── publishing_jobs ─────────────────────────────────────────────────────────
create table public.publishing_jobs (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  content_item_id      uuid not null,
  social_account_id    uuid not null,
  platform             text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  scheduled_for        timestamptz not null,
  timezone             text not null default 'UTC',
  status               text not null default 'pending' check (status in ('pending','queued','running','succeeded','failed','cancelled','blocked')),
  approval_id          uuid,
  auto_approved_reason text check (length(auto_approved_reason) <= 500),
  idempotency_key      text not null check (length(idempotency_key) between 8 and 200),
  attempts             integer not null default 0 check (attempts >= 0),
  max_attempts         integer not null default 4 check (max_attempts between 1 and 10),
  next_attempt_at      timestamptz,
  locked_at            timestamptz,
  last_error           text check (length(last_error) <= 2000),
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade,
  foreign key (approval_id, workspace_id) references public.agent_approvals(id, workspace_id) on delete restrict,
  constraint publishing_jobs_authorised check (
    status in ('pending','cancelled','blocked') or approval_id is not null or auto_approved_reason is not null
  )
);
-- One live job per (content, account): prevents duplicate posts.
create unique index publishing_jobs_no_duplicates on public.publishing_jobs(content_item_id, social_account_id)
  where status not in ('failed','cancelled');
create index publishing_jobs_due_idx on public.publishing_jobs(scheduled_for, next_attempt_at) where status = 'queued';
create index publishing_jobs_workspace_idx on public.publishing_jobs(workspace_id, status);
create index publishing_jobs_account_idx on public.publishing_jobs(social_account_id);
create index publishing_jobs_approval_idx on public.publishing_jobs(approval_id);
create trigger publishing_jobs_updated_at before update on public.publishing_jobs for each row execute function private.set_updated_at();

-- An approval-backed job may only be queued once that approval is APPROVED.
create or replace function private.publishing_job_approval_guard() returns trigger language plpgsql set search_path = '' as $$
declare st text;
begin
  if new.status in ('queued','running','succeeded') and new.approval_id is not null then
    select status into st from public.agent_approvals where id = new.approval_id;
    if st not in ('APPROVED','EXECUTING','COMPLETED') then
      raise exception 'publishing job requires an approved approval (approval is %)', st;
    end if;
  end if;
  return new;
end; $$;
create trigger publishing_jobs_approval_guard before insert or update on public.publishing_jobs
  for each row execute function private.publishing_job_approval_guard();

-- ── publishing_results ──────────────────────────────────────────────────────
create table public.publishing_results (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  publishing_job_id uuid not null,
  attempt           integer not null check (attempt >= 1),
  status            text not null check (status in ('success','failure')),
  external_post_id  text check (length(external_post_id) <= 200),
  url               text check (url ~ '^https://'),
  -- Sanitised provider response (never tokens/headers).
  response_summary  jsonb not null default '{}'::jsonb,
  error             text check (length(error) <= 2000),
  created_at        timestamptz not null default now(),
  unique (publishing_job_id, attempt),
  foreign key (publishing_job_id, workspace_id) references public.publishing_jobs(id, workspace_id) on delete cascade
);
create unique index publishing_results_one_success on public.publishing_results(publishing_job_id) where status = 'success';
create index publishing_results_workspace_idx on public.publishing_results(workspace_id, created_at desc);

-- ── scheduler functions (service role only) ─────────────────────────────────
create or replace function public.claim_publishing_jobs(p_limit integer default 10)
returns setof public.publishing_jobs language sql security definer set search_path = '' as $$
  update public.publishing_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_at = now(), updated_at = now()
   where j.id in (
     select q.id from public.publishing_jobs q
       join public.social_accounts a on a.id = q.social_account_id
      where q.status = 'queued'
        and q.scheduled_for <= now()
        and (q.next_attempt_at is null or q.next_attempt_at <= now())
        and q.attempts < q.max_attempts
        and a.status = 'connected'
      order by q.scheduled_for
      limit greatest(1, least(p_limit, 50))
      for update of q skip locked
   )
  returning j.*;
$$;

create or replace function public.complete_publishing_job(
  p_job_id uuid, p_success boolean, p_external_post_id text default null, p_url text default null,
  p_error text default null, p_response jsonb default '{}'::jsonb
) returns public.publishing_jobs language plpgsql security definer set search_path = '' as $$
declare j public.publishing_jobs;
begin
  select * into j from public.publishing_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'unknown publishing job'; end if;
  if j.status <> 'running' then raise exception 'job % is not running (status %)', p_job_id, j.status; end if;

  insert into public.publishing_results (workspace_id, publishing_job_id, attempt, status, external_post_id, url, response_summary, error)
  values (j.workspace_id, j.id, j.attempts, case when p_success then 'success' else 'failure' end,
          p_external_post_id, p_url, coalesce(p_response, '{}'::jsonb), left(p_error, 2000));

  if p_success then
    update public.publishing_jobs set status = 'succeeded', locked_at = null, last_error = null where id = j.id returning * into j;
    update public.content_items set status = 'published', published_at = now() where id = j.content_item_id;
  elsif j.attempts < j.max_attempts then
    -- Exponential backoff: 5, 10, 20, 40… minutes.
    update public.publishing_jobs
       set status = 'queued', locked_at = null, last_error = left(p_error, 2000),
           next_attempt_at = now() + (interval '5 minutes' * power(2, j.attempts - 1))
     where id = j.id returning * into j;
  else
    update public.publishing_jobs set status = 'failed', locked_at = null, last_error = left(p_error, 2000) where id = j.id returning * into j;
    update public.content_items set status = 'failed' where id = j.content_item_id;
  end if;
  return j;
end;
$$;

-- Jobs stuck in 'running' (crashed worker) return to the queue.
create or replace function public.reap_stuck_publishing_jobs(p_older_than interval default interval '15 minutes')
returns integer language sql security definer set search_path = '' as $$
  with r as (
    update public.publishing_jobs set status = 'queued', locked_at = null,
           last_error = 'reaped: worker did not complete'
     where status = 'running' and locked_at < now() - p_older_than
    returning 1)
  select count(*)::int from r;
$$;

revoke all on function public.claim_publishing_jobs(integer) from public, anon, authenticated;
revoke all on function public.complete_publishing_job(uuid, boolean, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.reap_stuck_publishing_jobs(interval) from public, anon, authenticated;
grant execute on function public.claim_publishing_jobs(integer) to service_role;
grant execute on function public.complete_publishing_job(uuid, boolean, text, text, text, jsonb) to service_role;
grant execute on function public.reap_stuck_publishing_jobs(interval) to service_role;

select private.apply_workspace_rls('public.campaigns');
select private.apply_workspace_rls('public.content_ideas');
select private.apply_workspace_rls('public.content_items');
select private.apply_workspace_rls('public.content_versions');
select private.apply_workspace_rls('public.content_assets');
select private.apply_workspace_rls('public.content_calendar');
select private.apply_workspace_rls('public.campaign_content');
select private.apply_workspace_rls('public.publishing_jobs');
select private.apply_workspace_rls('public.publishing_results');

alter publication supabase_realtime add table public.agent_approvals, public.publishing_jobs;
