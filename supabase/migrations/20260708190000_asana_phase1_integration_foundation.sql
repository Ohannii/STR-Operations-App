-- ============================================================
-- Asana Phase 1 integration foundation
-- ============================================================
-- Purpose:
--   Add the database foundation for a safe one-way app -> Asana
--   beta integration.
--
-- This migration is intentionally additive only:
--   - no data migration
--   - no Asana writes
--   - no secrets
--   - no worker/function code
--   - no changes to the existing issue/category/accountability model
--
-- Phase 1 safety model:
--   - STR Ops remains the source of truth.
--   - Asana is an outbound task handoff only.
--   - external_task_links prevents duplicate Asana task creation.
--   - integration_outbox gives us a durable retry queue.
--   - integration_settings gives us a company-scoped kill switch.
--   - flags.asana_task_url is a convenience display field only.

-- ------------------------------------------------------------
-- 1. flags: denormalised Asana task URL for simple UI display
-- ------------------------------------------------------------

alter table public.flags
  add column if not exists asana_task_url text;

comment on column public.flags.asana_task_url is
  'Convenience link to the external Asana task created for this flag. Durable provider-agnostic linkage lives in external_task_links.';

-- ------------------------------------------------------------
-- 2. integration_settings: company-scoped feature flag/config
-- ------------------------------------------------------------

create table if not exists public.integration_settings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,

  -- provider examples: 'asana', later 'pms', 'whatsapp', etc.
  provider    text not null,

  -- Defaults OFF. This is the kill switch.
  is_enabled  boolean not null default false,

  -- Non-secret provider config only.
  -- Never store tokens, PATs, API keys, service_role keys, or passwords here.
  config      jsonb not null default '{}'::jsonb,
  constraint integration_settings_config_is_object check (jsonb_typeof(config) = 'object'),
  constraint integration_settings_config_no_secret_keys check (
    not (config ?| array[
      'token',
      'access_token',
      'pat',
      'personal_access_token',
      'api_key',
      'apikey',
      'secret',
      'password',
      'service_role',
      'service_role_key',
      'client_secret',
      'refresh_token'
    ])
  ),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

drop trigger if exists trg_integration_settings_set_updated_at on public.integration_settings;
create trigger trg_integration_settings_set_updated_at
  before update on public.integration_settings
  for each row execute function public.set_updated_at();

create unique index if not exists uq_integration_settings_company_provider_active
  on public.integration_settings(company_id, provider)
  where deleted_at is null;

create index if not exists idx_integration_settings_company_id
  on public.integration_settings(company_id);

-- ------------------------------------------------------------
-- 3. external_task_links: durable provider-agnostic task links
-- ------------------------------------------------------------

create table if not exists public.external_task_links (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,

  -- provider examples: 'asana', later other outbound task systems.
  provider              text not null,

  -- Phase 1 uses entity_type = 'flag'.
  -- Kept generic so future providers/entities do not require a fork.
  internal_entity_type  text not null,
  internal_entity_id    uuid not null,

  external_workspace_gid text,
  external_project_gid   text,
  external_task_gid      text not null,
  external_task_url      text,

  sync_status           text not null default 'linked',
  last_synced_at         timestamptz,
  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

drop trigger if exists trg_external_task_links_set_updated_at on public.external_task_links;
create trigger trg_external_task_links_set_updated_at
  before update on public.external_task_links
  for each row execute function public.set_updated_at();

-- Exactly one active external task link per app entity/provider.
create unique index if not exists uq_external_task_links_internal_entity_active
  on public.external_task_links(company_id, provider, internal_entity_type, internal_entity_id)
  where deleted_at is null;

-- Avoid accidentally linking the same external task twice.
create unique index if not exists uq_external_task_links_external_task_active
  on public.external_task_links(company_id, provider, external_task_gid)
  where deleted_at is null;

create index if not exists idx_external_task_links_company_id
  on public.external_task_links(company_id);

create index if not exists idx_external_task_links_internal_entity
  on public.external_task_links(company_id, internal_entity_type, internal_entity_id);

-- ------------------------------------------------------------
-- 4. integration_outbox: durable outbound queue
-- ------------------------------------------------------------

create table if not exists public.integration_outbox (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,

  -- provider examples: 'asana', later other outbound integrations.
  provider      text not null,

  -- event_type example for Phase 1: 'asana.create_task_for_flag'
  event_type    text not null,

  -- Phase 1 uses entity_type = 'flag'.
  entity_type   text not null,
  entity_id     uuid not null,

  status        text not null default 'pending',
  payload       jsonb not null default '{}'::jsonb,

  attempt_count int not null default 0,
  available_at  timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  processed_at  timestamptz,
  last_error    text,

  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

drop trigger if exists trg_integration_outbox_set_updated_at on public.integration_outbox;
create trigger trg_integration_outbox_set_updated_at
  before update on public.integration_outbox
  for each row execute function public.set_updated_at();

-- Duplicate prevention:
-- one active outbox event per provider/event/entity.
create unique index if not exists uq_integration_outbox_event_entity_active
  on public.integration_outbox(company_id, provider, event_type, entity_type, entity_id)
  where deleted_at is null;

create index if not exists idx_integration_outbox_company_id
  on public.integration_outbox(company_id);

create index if not exists idx_integration_outbox_worker_queue
  on public.integration_outbox(status, available_at, created_at)
  where deleted_at is null;

create index if not exists idx_integration_outbox_entity
  on public.integration_outbox(company_id, entity_type, entity_id);

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------

alter table public.integration_settings enable row level security;
alter table public.external_task_links  enable row level security;
alter table public.integration_outbox   enable row level security;

-- integration_settings:
-- Readable by company members so the app can check whether a provider is enabled.
-- No INSERT/UPDATE/DELETE grant to authenticated users in this migration.
-- Settings changes should be admin/server-controlled.
create policy "members read company integration settings"
  on public.integration_settings
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- external_task_links:
-- Readable by company members for display/status.
-- Written by the server-side worker/service path only.
create policy "members read company external task links"
  on public.external_task_links
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- integration_outbox:
-- Members can read their company's queue state for transparency.
create policy "members read company integration outbox"
  on public.integration_outbox
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- Members may enqueue outbound events for their own company.
-- created_by = auth.uid() prevents a client from forging another user.
create policy "members insert company integration outbox"
  on public.integration_outbox
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = auth.uid()
  );

-- ------------------------------------------------------------
-- 6. Grants
-- ------------------------------------------------------------

grant select on public.integration_settings to authenticated;
grant select on public.external_task_links to authenticated;
grant select, insert on public.integration_outbox to authenticated;

-- Note:
-- No update/delete grants for the integration tables here.
-- The Supabase Edge Function worker/service path will process queue rows
-- server-side in a later approved slice.
