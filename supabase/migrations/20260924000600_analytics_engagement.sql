-- ============================================================================
-- Analytics + engagement.
--
-- Analytics rows come ONLY from platform APIs or an explicit owner import
-- (`source`). Nothing is synthesised; an unconnected account has no rows and
-- the UI shows an honest empty state.
--
-- Engagement: inbound comments/mentions/DMs and AI-drafted replies. A reply
-- can only be marked sent with a human-approved approval, and every reply is
-- recorded as AI-generated (is_ai_generated) — the character is an AI and
-- must not claim to be a human personally messaging.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.analytics_daily','public.content_metrics','public.audience_metrics',
                           'public.engagement_items','public.engagement_replies'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

-- ── analytics_daily (account level) ─────────────────────────────────────────
create table public.analytics_daily (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  character_id      uuid not null,
  social_account_id uuid not null,
  platform          text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  day               date not null,
  followers         bigint check (followers >= 0),
  following         bigint check (following >= 0),
  reach             bigint check (reach >= 0),
  impressions       bigint check (impressions >= 0),
  views             bigint check (views >= 0),
  likes             bigint check (likes >= 0),
  comments          bigint check (comments >= 0),
  shares            bigint check (shares >= 0),
  saves             bigint check (saves >= 0),
  profile_visits    bigint check (profile_visits >= 0),
  link_clicks       bigint check (link_clicks >= 0),
  source            text not null check (source in ('platform_api','manual_import')),
  captured_at       timestamptz not null default now(),
  unique (social_account_id, day),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade
);
create index analytics_daily_character_day_idx on public.analytics_daily(character_id, day desc);
create index analytics_daily_workspace_day_idx on public.analytics_daily(workspace_id, day desc);

-- ── content_metrics (per published item per day) ────────────────────────────
create table public.content_metrics (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  content_item_id      uuid not null,
  social_account_id    uuid not null,
  platform             text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  day                  date not null,
  views                bigint check (views >= 0),
  reach                bigint check (reach >= 0),
  impressions          bigint check (impressions >= 0),
  likes                bigint check (likes >= 0),
  comments             bigint check (comments >= 0),
  shares               bigint check (shares >= 0),
  saves                bigint check (saves >= 0),
  link_clicks          bigint check (link_clicks >= 0),
  watch_time_seconds   bigint check (watch_time_seconds >= 0),
  avg_view_duration_s  numeric(10,2) check (avg_view_duration_s >= 0),
  source               text not null check (source in ('platform_api','manual_import')),
  captured_at          timestamptz not null default now(),
  unique (content_item_id, social_account_id, day),
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade
);
create index content_metrics_workspace_day_idx on public.content_metrics(workspace_id, day desc);
create index content_metrics_account_idx on public.content_metrics(social_account_id);

-- ── audience_metrics (demographic snapshots) ────────────────────────────────
create table public.audience_metrics (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null,
  day               date not null,
  dimension         text not null check (dimension in ('age','gender','country','city','language','device')),
  bucket            text not null check (length(bucket) between 1 and 100),
  value             numeric(14,4) not null check (value >= 0),
  source            text not null check (source in ('platform_api','manual_import')),
  captured_at       timestamptz not null default now(),
  unique (social_account_id, day, dimension, bucket),
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade
);
create index audience_metrics_workspace_idx on public.audience_metrics(workspace_id, day desc);

-- ── engagement_items (inbound) ──────────────────────────────────────────────
create table public.engagement_items (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  social_account_id   uuid not null,
  platform            text not null check (platform ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- 'dm' only for conversations the other person started (inbound).
  kind                text not null check (kind in ('comment','mention','dm','reply')),
  external_id         text not null check (length(external_id) between 1 and 200),
  parent_external_id  text,
  content_item_id     uuid,
  author_handle       text check (length(author_handle) <= 200),
  author_external_id  text check (length(author_external_id) <= 200),
  body                text not null check (length(body) <= 10000),
  received_at         timestamptz not null,
  status              text not null default 'new' check (status in ('new','needs_reply','replied','ignored','hidden','escalated')),
  moderation_status   text not null default 'unchecked' check (moderation_status in ('unchecked','ok','flagged','blocked')),
  moderation_labels   jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (platform, social_account_id, external_id),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (social_account_id, workspace_id) references public.social_accounts(id, workspace_id) on delete cascade,
  foreign key (content_item_id, workspace_id) references public.content_items(id, workspace_id) on delete set null (content_item_id)
);
create index engagement_items_inbox_idx on public.engagement_items(workspace_id, status, received_at desc);
create index engagement_items_character_idx on public.engagement_items(character_id);
create index engagement_items_content_idx on public.engagement_items(content_item_id);
create trigger engagement_items_updated_at before update on public.engagement_items for each row execute function private.set_updated_at();

-- ── engagement_replies (AI-suggested / approved / sent) ─────────────────────
create table public.engagement_replies (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  engagement_item_id uuid not null,
  body               text not null check (length(trim(body)) between 1 and 2200),
  is_ai_generated    boolean not null default true,
  status             text not null default 'suggested' check (status in ('suggested','awaiting_approval','approved','rejected','sent','failed')),
  approval_id        uuid,
  agent_run_id       uuid,
  sent_at            timestamptz,
  external_id        text,
  error              text check (length(error) <= 1000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (engagement_item_id, workspace_id) references public.engagement_items(id, workspace_id) on delete cascade,
  foreign key (approval_id, workspace_id) references public.agent_approvals(id, workspace_id) on delete restrict,
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id),
  constraint engagement_replies_send_needs_approval check (status not in ('approved','sent') or approval_id is not null)
);
create index engagement_replies_item_idx on public.engagement_replies(engagement_item_id);
create index engagement_replies_workspace_idx on public.engagement_replies(workspace_id, status);
create index engagement_replies_approval_idx on public.engagement_replies(approval_id);
create trigger engagement_replies_updated_at before update on public.engagement_replies for each row execute function private.set_updated_at();

select private.apply_workspace_rls('public.analytics_daily');
select private.apply_workspace_rls('public.content_metrics');
select private.apply_workspace_rls('public.audience_metrics');
select private.apply_workspace_rls('public.engagement_items');
select private.apply_workspace_rls('public.engagement_replies');
