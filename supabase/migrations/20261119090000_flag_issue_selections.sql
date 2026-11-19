-- ============================================================
-- flag_issue_selections + finalize_flag_issue_with_photos
-- ============================================================
-- "Report issue" from a pre-arrival photo (Nov 2026). Staff pick quick
-- Asana-style details when they report an issue from a pack photo:
--   * Category (+ the applicable Inventory / Linen / HOA incident type)
--   * "What needs to happen?"  (Asana "Replacement Required", multi)
--   * optional Severity and Fix Owner (for triage)
-- These are stored WITH the issue (one row per flag) so they survive
-- reloads, queue failures and worker retries. The Asana worker reads them
-- fresh from here when it creates the task; nothing is trusted from the
-- outbox payload.
--
-- Values are semantic keys (never Asana GIDs): GIDs are per project and
-- live in the app's field configuration.
--
-- finalize_flag_issue_with_photos wraps the existing, unchanged
-- finalize_flag_with_photos (same transaction, SECURITY INVOKER, same
-- idempotent replay + exact stored-file checks) and records the
-- selections in the SAME transaction: either the flag, its photo and its
-- selections all exist, or none do.
--
-- Additive only: no existing table, policy or function is altered.
-- ============================================================

-- Allowed "What needs to happen?" values: subset, no duplicates, and N/A
-- cannot be combined with an action.
create or replace function public.issue_actions_valid(p_actions text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_actions is not null
     and p_actions <@ array['fix', 'clean', 'replace', 'na', 'record_keeping']::text[]
     and cardinality(p_actions) = (select count(distinct a) from unnest(p_actions) as a)
     and (not ('na' = any (p_actions)) or cardinality(p_actions) = 1)
$$;

-- THE one source-photo ownership rule, used by BOTH the direct-insert RLS
-- policy and the RPC (so a direct insert can never link what the RPC would
-- refuse). True when no source photo is given, or when the photo:
--   * is in the SAME company as the selections row AND the flag,
--   * is on the SAME property as the flag,
--   * is a pre-arrival pack photo (evidence_pack_id set),
--   * is still available (not deleted, bytes not purged).
-- SECURITY INVOKER: the caller's own RLS on photos / flags also applies.
create or replace function public.issue_source_photo_ok(
  p_company_id uuid,
  p_flag_id    uuid,
  p_photo_id   uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select p_photo_id is null
      or exists (
        select 1
          from public.photos ph
          join public.flags f on f.id = p_flag_id
         where ph.id = p_photo_id
           and p_company_id is not null
           and ph.company_id = p_company_id
           and f.company_id = p_company_id
           and ph.property_id is not null
           and ph.property_id = f.property_id
           and ph.evidence_pack_id is not null
           and ph.deleted_at is null
           and ph.bytes_deleted_at is null
      )
$$;

create table if not exists public.flag_issue_selections (
  flag_id              uuid primary key references public.flags(id) on delete cascade,
  company_id           uuid not null references public.companies(id) on delete cascade,
  -- The pre-arrival pack photo the issue was reported from (the pack's own
  -- photo row is never modified; the issue gets its own copied photo).
  source_pack_photo_id uuid references public.photos(id) on delete set null,
  category             text,
  incident_type        text,
  actions              text[] not null default '{}',
  severity             text,
  fix_owner            text,
  created_by           uuid not null references public.profiles(id),
  created_at           timestamptz not null default now(),

  constraint flag_issue_selections_category_chk check (
    category is null or category in
      ('inventory', 'linen', 'maintenance', 'hoa', 'amenity', 'permanent_fixtures')
  ),
  -- coalesce(..., false): with category NULL the comparisons are NULL, and
  -- a NULL CHECK result would otherwise PASS.
  constraint flag_issue_selections_incident_chk check (
    incident_type is null
    or coalesce(
       (category = 'inventory' and incident_type in (
          'physical_damage', 'missing_item', 'appliance_failure', 'stain_to_furniture',
          'lost_keys', 'lost_remote', 'old_damage', 'wear_and_tear', 'irrecoverable', 'other'))
    or (category = 'linen' and incident_type in (
          'stain', 'torn_irreparable', 'missing', 'wear_and_tear', 'other'))
    or (category = 'hoa' and incident_type in (
          'noise_complaint', 'facilities', 'warning_1', 'warning_2', 'warning_3_fine')),
       false)
  ),
  constraint flag_issue_selections_actions_chk check (public.issue_actions_valid(actions)),
  constraint flag_issue_selections_severity_chk check (
    severity is null or severity in ('minor', 'moderate', 'major', 'write_off')
  ),
  constraint flag_issue_selections_fix_owner_chk check (
    fix_owner is null or fix_owner in ('maintenance', 'housekeeping', 'vendor', 'drop_inn')
  )
);

create index if not exists idx_flag_issue_selections_source_photo
  on public.flag_issue_selections (source_pack_photo_id)
  where source_pack_photo_id is not null;
create index if not exists idx_flag_issue_selections_company
  on public.flag_issue_selections (company_id);

alter table public.flag_issue_selections enable row level security;

drop policy if exists "flag issue selections: members read" on public.flag_issue_selections;
create policy "flag issue selections: members read"
  on public.flag_issue_selections for select to authenticated
  using (public.is_company_member(company_id));

-- Insert only for the reporter of a flag in the caller's own company.
-- (The RPC below is the normal path; this policy makes a direct insert no
-- more powerful than the RPC.) No UPDATE / DELETE: selections are an
-- immutable record of what was reported.
drop policy if exists "flag issue selections: reporter inserts" on public.flag_issue_selections;
create policy "flag issue selections: reporter inserts"
  on public.flag_issue_selections for insert to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = auth.uid()
    and exists (
      select 1 from public.flags f
      where f.id = flag_id
        and f.company_id = flag_issue_selections.company_id
        and f.raised_by = auth.uid()
        and f.deleted_at is null
    )
    -- The source photo must pass the SAME ownership rule as the RPC:
    -- same company, same property as the flag, an available pack photo.
    and public.issue_source_photo_ok(company_id, flag_id, source_pack_photo_id)
  );

revoke all on public.flag_issue_selections from anon, public;
grant select, insert on public.flag_issue_selections to authenticated;


create or replace function public.finalize_flag_issue_with_photos(
  p_flag_id              uuid,
  p_property_id          uuid,
  p_category_id          uuid,
  p_severity             text,
  p_description          text,
  p_issue_title          text,
  p_accountability       text,
  p_photos               jsonb,
  p_source_pack_photo_id uuid,
  p_selections           jsonb
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_result     text;
  v_company    uuid;
  v_category   text;
  v_incident   text;
  v_actions    text[];
  v_severity   text;
  v_fix_owner  text;
  v_existing   public.flag_issue_selections%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  ----------------------------------------------------------------
  -- 1. Validate the selections JSON (independent of TS).
  ----------------------------------------------------------------
  if p_selections is null or jsonb_typeof(p_selections) <> 'object' then
    raise exception 'issue selections must be a JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_selections) k
    where k not in ('category', 'incident_type', 'actions', 'severity', 'fix_owner')
  ) then
    raise exception 'unknown issue selection key' using errcode = '22023';
  end if;
  if p_selections ? 'actions'
     and jsonb_typeof(p_selections->'actions') not in ('array', 'null') then
    raise exception 'actions must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(nullif(p_selections->'actions', 'null'::jsonb), '[]'::jsonb)) e
    where jsonb_typeof(e) <> 'string'
  ) then
    raise exception 'actions must be strings' using errcode = '22023';
  end if;

  v_category  := nullif(btrim(coalesce(p_selections->>'category', '')), '');
  v_incident  := nullif(btrim(coalesce(p_selections->>'incident_type', '')), '');
  v_severity  := nullif(btrim(coalesce(p_selections->>'severity', '')), '');
  v_fix_owner := nullif(btrim(coalesce(p_selections->>'fix_owner', '')), '');
  -- Canonical order + de-duplicated; validity is enforced by the CHECKs.
  select coalesce(array_agg(k order by ord), '{}')
    into v_actions
    from (
      select distinct a as k,
        array_position(array['fix', 'clean', 'replace', 'na', 'record_keeping']::text[], a) as ord
      from jsonb_array_elements_text(
        coalesce(nullif(p_selections->'actions', 'null'::jsonb), '[]'::jsonb)) as a
    ) s;
  if not public.issue_actions_valid(v_actions) then
    raise exception 'invalid actions' using errcode = '22023';
  end if;

  ----------------------------------------------------------------
  -- 2. The flag + its photo(s): the existing, unchanged finaliser.
  ----------------------------------------------------------------
  v_result := public.finalize_flag_with_photos(
    p_flag_id, p_property_id, p_category_id, p_severity, p_description,
    p_issue_title, p_accountability, p_photos
  );

  select company_id into v_company from public.flags where id = p_flag_id;

  ----------------------------------------------------------------
  -- 3. Selections: idempotent replay (identical) or fresh insert.
  --    A fresh insert must pass the source-photo ownership rule (same
  --    company AND property, an available pack photo, visible to the
  --    caller). A replay is compared field-by-field instead, so a retry
  --    stays idempotent even if the pack photo has since been removed.
  ----------------------------------------------------------------
  select * into v_existing from public.flag_issue_selections where flag_id = p_flag_id;
  if found then
    if v_existing.company_id           is distinct from v_company
       or v_existing.source_pack_photo_id is distinct from p_source_pack_photo_id
       or v_existing.category          is distinct from v_category
       or v_existing.incident_type     is distinct from v_incident
       or v_existing.actions           is distinct from v_actions
       or v_existing.severity          is distinct from v_severity
       or v_existing.fix_owner         is distinct from v_fix_owner
       or v_existing.created_by        is distinct from v_user then
      raise exception 'issue % already exists with different selections', p_flag_id
        using errcode = '23505';
    end if;
  else
    if not public.issue_source_photo_ok(v_company, p_flag_id, p_source_pack_photo_id) then
      raise exception 'source pack photo % not found', p_source_pack_photo_id
        using errcode = 'P0002';
    end if;
    insert into public.flag_issue_selections (
      flag_id, company_id, source_pack_photo_id, category, incident_type,
      actions, severity, fix_owner, created_by
    ) values (
      p_flag_id, v_company, p_source_pack_photo_id, v_category, v_incident,
      v_actions, v_severity, v_fix_owner, v_user
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.finalize_flag_issue_with_photos(
  uuid, uuid, uuid, text, text, text, text, jsonb, uuid, jsonb
) from public, anon;
grant execute on function public.finalize_flag_issue_with_photos(
  uuid, uuid, uuid, text, text, text, text, jsonb, uuid, jsonb
) to authenticated;
grant execute on function public.issue_actions_valid(text[]) to authenticated;
-- The Asana worker connects as service_role (bypasses RLS but still needs a
-- table GRANT). Read-only: it reads the reporter's selections when it
-- creates the task. Same pattern as 20260710120000.
grant select on public.flag_issue_selections to service_role;

revoke all on function public.issue_source_photo_ok(uuid, uuid, uuid) from public, anon;
grant execute on function public.issue_source_photo_ok(uuid, uuid, uuid) to authenticated;
