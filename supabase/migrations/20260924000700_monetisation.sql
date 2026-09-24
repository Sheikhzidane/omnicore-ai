-- ============================================================================
-- Monetisation: brand contacts, leads, brand deals, affiliate links, products,
-- revenue, expenses, and a per-character financial summary view.
--
-- Money is stored as integer minor units (cents) + ISO currency. Revenue and
-- expenses are recorded facts (entered by the owner or imported); nothing is
-- estimated into these tables. Sponsored deals always require disclosure.
-- Brand outreach itself is an approval-gated action (agent_approvals).
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['public.brand_contacts','public.leads','public.brand_deals','public.affiliate_links',
                           'public.products','public.revenue','public.expenses'] loop
    if to_regclass(t) is not null then
      raise exception 'Preflight: % already exists. See supabase/migrations/README.md.', t;
    end if;
  end loop;
end $$;

create table public.brand_contacts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  brand_name    text not null check (length(trim(brand_name)) between 1 and 200),
  full_name     text check (length(full_name) <= 200),
  email         text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 320),
  role_title    text check (length(role_title) <= 200),
  phone         text check (length(phone) <= 50),
  website       text check (website ~ '^https?://'),
  -- Why we may contact this person. No scraped/harvested contacts.
  consent_basis text not null check (consent_basis in ('published_business_contact','inbound','referral','existing_relationship')),
  do_not_contact boolean not null default false,
  opted_out_at  timestamptz,
  notes         text check (length(notes) <= 4000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index brand_contacts_email_idx on public.brand_contacts(workspace_id, lower(email)) where email is not null;
create trigger brand_contacts_updated_at before update on public.brand_contacts for each row execute function private.set_updated_at();

create table public.leads (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  character_id          uuid,
  contact_id            uuid,
  brand_name            text not null check (length(trim(brand_name)) between 1 and 200),
  website               text check (website ~ '^https?://'),
  stage                 text not null default 'prospect' check (stage in ('prospect','researched','pitched','replied','negotiating','won','lost')),
  stage_changed_at      timestamptz not null default now(),
  fit_score             numeric(3,1) check (fit_score between 0 and 10),
  fit_reasoning         text check (length(fit_reasoning) <= 2000),
  fit_signals           jsonb not null default '{}'::jsonb,
  source                text not null default 'manual' check (source in ('manual','csv','inbound','agent_research','referral')),
  estimated_value_cents bigint check (estimated_value_cents >= 0),
  next_action           text check (length(next_action) <= 500),
  next_action_at        timestamptz,
  lost_reason           text check (length(lost_reason) <= 500),
  notes                 text check (length(notes) <= 4000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (contact_id, workspace_id) references public.brand_contacts(id, workspace_id) on delete set null (contact_id)
);
create index leads_pipeline_idx on public.leads(workspace_id, stage);
create index leads_character_idx on public.leads(character_id);
create index leads_contact_idx on public.leads(contact_id);
create trigger leads_updated_at before update on public.leads for each row execute function private.set_updated_at();

create table public.brand_deals (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  character_id        uuid not null,
  lead_id             uuid,
  contact_id          uuid,
  campaign_id         uuid,
  title               text not null check (length(trim(title)) between 1 and 200),
  status              text not null default 'negotiating' check (status in (
                        'negotiating','contracted','in_production','delivered','invoiced','paid','cancelled')),
  value_cents         bigint not null default 0 check (value_cents >= 0),
  currency            text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  deliverables        jsonb not null default '[]'::jsonb,
  usage_rights        text check (length(usage_rights) <= 1000),
  exclusivity_until   date,
  -- Sponsored content must always be disclosed; cannot be switched off.
  disclosure_required boolean not null default true check (disclosure_required),
  start_date          date,
  due_date            date,
  invoiced_at         timestamptz,
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (lead_id, workspace_id) references public.leads(id, workspace_id) on delete set null (lead_id),
  foreign key (contact_id, workspace_id) references public.brand_contacts(id, workspace_id) on delete set null (contact_id),
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id)
);
create index brand_deals_workspace_idx on public.brand_deals(workspace_id, status);
create index brand_deals_character_idx on public.brand_deals(character_id);
create index brand_deals_lead_idx on public.brand_deals(lead_id);
create index brand_deals_contact_idx on public.brand_deals(contact_id);
create index brand_deals_campaign_idx on public.brand_deals(campaign_id);
create trigger brand_deals_updated_at before update on public.brand_deals for each row execute function private.set_updated_at();

-- Sponsored content links to its deal.
alter table public.content_items add column brand_deal_id uuid;
alter table public.content_items add constraint content_items_brand_deal_fk
  foreign key (brand_deal_id, workspace_id) references public.brand_deals(id, workspace_id) on delete set null (brand_deal_id);
alter table public.content_items add constraint content_items_deal_is_sponsored check (brand_deal_id is null or is_sponsored);
create index content_items_brand_deal_idx on public.content_items(brand_deal_id);

create table public.affiliate_links (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  character_id    uuid,
  program         text not null check (length(trim(program)) between 1 and 120),
  merchant        text check (length(merchant) <= 200),
  destination_url text not null check (destination_url ~ '^https://'),
  tracking_url    text check (tracking_url ~ '^https://'),
  code            text check (length(code) <= 100),
  commission_type text not null default 'percent' check (commission_type in ('percent','fixed','hybrid','unknown')),
  commission_rate numeric(8,4) check (commission_rate >= 0),
  disclosure_text text not null default 'Affiliate link — I may earn a commission.' check (length(trim(disclosure_text)) >= 5),
  status          text not null default 'active' check (status in ('active','paused','expired')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index affiliate_links_workspace_idx on public.affiliate_links(workspace_id, status);
create index affiliate_links_character_idx on public.affiliate_links(character_id);
create trigger affiliate_links_updated_at before update on public.affiliate_links for each row execute function private.set_updated_at();

create table public.products (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid,
  name         text not null check (length(trim(name)) between 1 and 200),
  kind         text not null check (kind in ('digital','physical','service','membership')),
  price_cents  bigint check (price_cents >= 0),
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status       text not null default 'draft' check (status in ('draft','active','retired')),
  external_ref text check (length(external_ref) <= 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade
);
create index products_workspace_idx on public.products(workspace_id);
create index products_character_idx on public.products(character_id);
create trigger products_updated_at before update on public.products for each row execute function private.set_updated_at();

create table public.revenue (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  character_id      uuid,
  source_type       text not null check (source_type in ('affiliate','sponsorship','product','subscription','tips','licensing','platform_payout','other')),
  brand_deal_id     uuid,
  affiliate_link_id uuid,
  product_id        uuid,
  campaign_id       uuid,
  amount_cents      bigint not null check (amount_cents >= 0),
  currency          text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  occurred_on       date not null,
  status            text not null default 'received' check (status in ('expected','pending','received','refunded')),
  external_ref      text check (length(external_ref) <= 200),
  description       text check (length(description) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, source_type, external_ref),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (brand_deal_id, workspace_id) references public.brand_deals(id, workspace_id) on delete set null (brand_deal_id),
  foreign key (affiliate_link_id, workspace_id) references public.affiliate_links(id, workspace_id) on delete set null (affiliate_link_id),
  foreign key (product_id, workspace_id) references public.products(id, workspace_id) on delete set null (product_id),
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id)
);
create index revenue_workspace_date_idx on public.revenue(workspace_id, occurred_on desc);
create index revenue_character_idx on public.revenue(character_id);
create index revenue_deal_idx on public.revenue(brand_deal_id);
create index revenue_affiliate_idx on public.revenue(affiliate_link_id);
create index revenue_product_idx on public.revenue(product_id);
create index revenue_campaign_idx on public.revenue(campaign_id);
create trigger revenue_updated_at before update on public.revenue for each row execute function private.set_updated_at();

create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  character_id uuid,
  campaign_id  uuid,
  category     text not null check (category in ('ai_compute','software','ads','production','contractor','fees','other')),
  vendor       text check (length(vendor) <= 200),
  amount_cents bigint not null check (amount_cents >= 0),
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  occurred_on  date not null,
  description  text check (length(description) <= 1000),
  receipt_path text,
  agent_run_id uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (character_id, workspace_id) references public.characters(id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id) references public.campaigns(id, workspace_id) on delete set null (campaign_id),
  foreign key (agent_run_id, workspace_id) references public.agent_runs(id, workspace_id) on delete set null (agent_run_id)
);
create index expenses_workspace_date_idx on public.expenses(workspace_id, occurred_on desc);
create index expenses_character_idx on public.expenses(character_id);
create index expenses_campaign_idx on public.expenses(campaign_id);
create trigger expenses_updated_at before update on public.expenses for each row execute function private.set_updated_at();

select private.apply_workspace_rls('public.brand_contacts');
select private.apply_workspace_rls('public.leads');
select private.apply_workspace_rls('public.brand_deals');
select private.apply_workspace_rls('public.affiliate_links');
select private.apply_workspace_rls('public.products');
select private.apply_workspace_rls('public.revenue');
select private.apply_workspace_rls('public.expenses');

-- Per-character P&L in minor units, per currency. security_invoker makes the
-- view obey the caller's RLS (members only see their own workspace).
create view public.character_financials with (security_invoker = true) as
with rev as (
  select workspace_id, character_id, currency, sum(amount_cents) filter (where status = 'received') as revenue_cents
  from public.revenue group by 1, 2, 3
), exp as (
  select workspace_id, character_id, currency, sum(amount_cents) as expense_cents
  from public.expenses group by 1, 2, 3
)
select coalesce(r.workspace_id, e.workspace_id) as workspace_id,
       coalesce(r.character_id, e.character_id) as character_id,
       coalesce(r.currency, e.currency) as currency,
       coalesce(r.revenue_cents, 0)::bigint as revenue_cents,
       coalesce(e.expense_cents, 0)::bigint as expense_cents,
       (coalesce(r.revenue_cents, 0) - coalesce(e.expense_cents, 0))::bigint as profit_cents
from rev r full join exp e
  on r.workspace_id = e.workspace_id and r.character_id is not distinct from e.character_id and r.currency = e.currency;
revoke all on public.character_financials from anon;
grant select on public.character_financials to authenticated;
