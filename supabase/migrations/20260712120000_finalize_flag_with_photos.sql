-- ============================================================
-- finalize_flag_with_photos — transactional field-flag finalisation
-- ============================================================
-- Slice 11B-1 (hardened). Atomically creates a field-raised flag together
-- with its (1..5) evidence photo rows.
--
-- SECURITY INVOKER: runs as the calling user, so RLS + the photos
-- cross-tenant trigger still apply — NO service_role. The whole function
-- body is ONE transaction, so any error rolls back the flag AND every
-- photo row.
--
-- THREAT MODEL: the function is `grant execute ... to authenticated`, so a
-- user could call it DIRECTLY (bypassing the server action). Therefore the
-- SQL must independently derive every sensitive value and independently
-- validate every input — it may not trust anything a caller could forge:
--   * company_id      — derived from the verified property (never a param)
--   * uploaded_by     — auth.uid() (never a param)
--   * retention_class — derived in SQL from category + accountability
--                       (never a param); see derive_photo_retention_class
--   * storage paths   — derived from company_id / flag_id / photo_id
--                       (never a param)
-- Photo JSON structure (count, dupes, numeric ranges) is validated in SQL
-- too, not just in the TypeScript action.
--
-- STORAGE INTEGRITY: because the RPC is directly callable, it does NOT
-- trust the action's pre-flight Storage check. For every submitted photo
-- it verifies, INSIDE the transaction, that the DERIVED master and
-- thumbnail objects actually exist in storage.objects (bucket
-- 'evidence-photos') under the derived company/flag path. Any missing
-- object raises and rolls back the whole flag + photo set, so no photos
-- row can exist without its bytes. The check reads storage.objects via
-- the caller's own RLS (members-read-company-objects) — SECURITY INVOKER,
-- no widened Storage policy. Object paths are always derived, never
-- accepted from the caller.
--
-- Idempotency (relationship-verified, NOT blind "on conflict do nothing"):
-- a replay is `already_finalized` ONLY when the full immutable payload
-- matches — every compared flag field AND every compared photo field. If
-- the same ids exist with ANY different data, we RAISE instead.
--
-- p_photos shape: [{ "photo_id": uuid, "width": int, "height": int,
--                    "size_bytes": int }, ...]


-- ----------------------------------------------------------------
-- Retention derivation (SQL mirror of src/lib/photos/retention.ts
-- deriveRetentionClass). Keep the two in lockstep. hasOpenDispute is
-- always false at flag-creation time, so it is omitted here.
-- ----------------------------------------------------------------
create or replace function public.derive_photo_retention_class(
  p_category_key   text,
  p_accountability text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_accountability in ('guest_damage', 'guest')        then 'dispute_evidence'
    when p_accountability in ('owner_chargeable', 'owner')    then 'owner_chargeable_evidence'
    when p_category_key   in ('safety_urgent', 'safety')      then 'dispute_evidence'
    when p_category_key    = 'guest_damage'                   then 'dispute_evidence'
    when p_category_key    = 'owner_chargeable'               then 'owner_chargeable_evidence'
    when p_category_key   in ('access_keys_lock', 'access_keys')          then 'security_access_evidence'
    when p_category_key   in ('maintenance_issue', 'appliance_furniture') then 'maintenance_before_after'
    when p_category_key   in ('inventory_missing', 'inventory_damaged')   then 'inventory_evidence'
    else 'routine_post_stay'
  end
$$;


create or replace function public.finalize_flag_with_photos(
  p_flag_id        uuid,
  p_property_id    uuid,
  p_category_id    uuid,
  p_severity       text,
  p_description    text,
  p_issue_title    text,
  p_accountability text,
  p_photos         jsonb
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user           uuid := auth.uid();
  v_company        uuid;
  v_category_key   text;
  v_retention      text;
  v_severity       text;
  v_description    text;
  v_issue_title    text;
  v_accountability text;
  v_existing_flag  public.flags%rowtype;
  v_existing_photo public.photos%rowtype;
  v_flag_new       boolean := false;
  v_count          int;
  v_distinct       int;
  v_elem           jsonb;
  v_photo_id       uuid;
  v_master         text;
  v_thumb          text;
  v_w              int;
  v_h              int;
  v_size           int;
begin
  ----------------------------------------------------------------
  -- 0. Auth
  ----------------------------------------------------------------
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  ----------------------------------------------------------------
  -- 1. Derive company from the verified property (never a param).
  ----------------------------------------------------------------
  select company_id into v_company
  from public.properties
  where id = p_property_id and deleted_at is null;
  if v_company is null then
    raise exception 'property % not found', p_property_id using errcode = 'P0002';
  end if;

  ----------------------------------------------------------------
  -- 2. Resolve category key + derive retention_class in SQL
  --    (never a param). Category must be visible to the caller.
  ----------------------------------------------------------------
  select key into v_category_key
  from public.flag_categories
  where id = p_category_id;
  if v_category_key is null then
    raise exception 'flag category % not found', p_category_id using errcode = 'P0002';
  end if;

  ----------------------------------------------------------------
  -- 3. Normalise + validate the flag fields (independent of TS).
  ----------------------------------------------------------------
  v_severity    := btrim(coalesce(p_severity, ''));
  if v_severity not in ('low', 'med', 'high') then
    raise exception 'invalid severity %', v_severity using errcode = '22023';
  end if;

  v_description := btrim(coalesce(p_description, ''));
  if v_description = '' then
    raise exception 'description is required' using errcode = '22023';
  end if;
  if length(v_description) > 1000 then
    raise exception 'description too long' using errcode = '22023';
  end if;

  -- issue_title: trim, cap 80, null when empty (matches the action).
  v_issue_title := left(nullif(btrim(coalesce(p_issue_title, '')), ''), 80);

  -- accountability: trim; treat empty / 'needs_triage' as null
  -- (matches the action's "not yet decided" semantics).
  v_accountability := nullif(nullif(btrim(coalesce(p_accountability, '')), ''), 'needs_triage');

  v_retention := public.derive_photo_retention_class(v_category_key, v_accountability);

  ----------------------------------------------------------------
  -- 4. Validate the photo JSON structure (independent of TS).
  ----------------------------------------------------------------
  if p_photos is null or jsonb_typeof(p_photos) <> 'array' then
    raise exception 'photos must be a JSON array' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_photos);
  if v_count < 1 or v_count > 5 then
    raise exception 'photo count must be between 1 and 5 (got %)', v_count
      using errcode = '22023';
  end if;

  for v_elem in select value from jsonb_array_elements(p_photos)
  loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each photo must be a JSON object' using errcode = '22023';
    end if;
    if not (v_elem ? 'photo_id')
       or (v_elem->>'photo_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'invalid or missing photo_id' using errcode = '22023';
    end if;
    if jsonb_typeof(v_elem->'width') <> 'number'
       or jsonb_typeof(v_elem->'height') <> 'number'
       or jsonb_typeof(v_elem->'size_bytes') <> 'number' then
      raise exception 'photo width/height/size_bytes must be numbers'
        using errcode = '22023';
    end if;
    if (v_elem->>'width')::numeric  <= 0 or (v_elem->>'width')::numeric  > 20000
       or (v_elem->>'height')::numeric <= 0 or (v_elem->>'height')::numeric > 20000
       or (v_elem->>'size_bytes')::numeric <= 0
       or (v_elem->>'size_bytes')::numeric > 10485760 then
      raise exception 'photo dimensions/size out of range' using errcode = '22023';
    end if;
  end loop;

  -- Reject duplicate photo ids.
  select count(distinct elem->>'photo_id') into v_distinct
  from jsonb_array_elements(p_photos) elem;
  if v_distinct <> v_count then
    raise exception 'duplicate photo ids in submission' using errcode = '22023';
  end if;

  ----------------------------------------------------------------
  -- 5. Flag: full-payload idempotent replay, or fresh insert.
  ----------------------------------------------------------------
  select * into v_existing_flag from public.flags where id = p_flag_id;
  if found then
    -- Soft-deleted flags are NOT a valid replay target (req 6).
    if v_existing_flag.deleted_at is not null then
      raise exception 'flag % was soft-deleted; cannot replay', p_flag_id
        using errcode = '23505';
    end if;
    if v_existing_flag.company_id                   is distinct from v_company
       or v_existing_flag.property_id               is distinct from p_property_id
       or v_existing_flag.flag_category_id          is distinct from p_category_id
       or v_existing_flag.raised_by                 is distinct from v_user
       or v_existing_flag.severity                  is distinct from v_severity
       or v_existing_flag.description               is distinct from v_description
       or v_existing_flag.issue_title               is distinct from v_issue_title
       or v_existing_flag.chargeable_party_decision is distinct from v_accountability then
      raise exception 'flag % already exists with different data', p_flag_id
        using errcode = '23505';
    end if;
    -- full-payload match → idempotent replay.
  else
    insert into public.flags (
      id, company_id, property_id, flag_category_id, status,
      severity, description, issue_title, chargeable_party_decision, raised_by
    ) values (
      p_flag_id, v_company, p_property_id, p_category_id, 'raised',
      v_severity, v_description, v_issue_title, v_accountability, v_user
    );
    v_flag_new := true;
  end if;

  ----------------------------------------------------------------
  -- 6. Photos: full-payload idempotent replay, or fresh insert.
  ----------------------------------------------------------------
  for v_elem in select value from jsonb_array_elements(p_photos)
  loop
    v_photo_id := (v_elem->>'photo_id')::uuid;
    v_w    := (v_elem->>'width')::int;
    v_h    := (v_elem->>'height')::int;
    v_size := (v_elem->>'size_bytes')::int;
    v_master := format('companies/%s/flags/%s/%s.jpg', v_company, p_flag_id, v_photo_id);
    v_thumb  := format('companies/%s/flags/%s/%s_thumb.jpg', v_company, p_flag_id, v_photo_id);

    -- Storage integrity: the exact derived master + thumbnail objects
    -- MUST already exist (bytes uploaded) before we record the row. The
    -- (bucket_id, name) uniqueness in storage.objects means existence ==
    -- exactly one object, so this enforces "exactly one master + one
    -- thumbnail per photo". Missing bytes raise → whole txn rolls back.
    perform 1 from storage.objects
      where bucket_id = 'evidence-photos' and name = v_master;
    if not found then
      raise exception 'evidence master object missing for photo %', v_photo_id
        using errcode = '23514';
    end if;
    perform 1 from storage.objects
      where bucket_id = 'evidence-photos' and name = v_thumb;
    if not found then
      raise exception 'evidence thumbnail object missing for photo %', v_photo_id
        using errcode = '23514';
    end if;

    select * into v_existing_photo from public.photos where id = v_photo_id;
    if found then
      -- Soft-deleted rows are NOT a valid replay target (req 6).
      if v_existing_photo.deleted_at is not null then
        raise exception 'photo % was soft-deleted; cannot replay', v_photo_id
          using errcode = '23505';
      end if;
      if v_existing_photo.company_id     is distinct from v_company
         or v_existing_photo.property_id    is distinct from p_property_id
         or v_existing_photo.flag_id        is distinct from p_flag_id
         or v_existing_photo.storage_path   is distinct from v_master
         or v_existing_photo.thumbnail_path is distinct from v_thumb
         or v_existing_photo.width          is distinct from v_w
         or v_existing_photo.height         is distinct from v_h
         or v_existing_photo.size_bytes     is distinct from v_size
         or v_existing_photo.uploaded_by    is distinct from v_user
         or v_existing_photo.retention_class is distinct from v_retention then
        raise exception 'photo % already exists with different data', v_photo_id
          using errcode = '23505';
      end if;
      -- full-payload match → idempotent replay.
    else
      insert into public.photos (
        id, company_id, property_id, flag_id, entity_type, retention_class,
        uploaded_by, storage_path, thumbnail_path, mime_type,
        width, height, size_bytes, sync_status
      ) values (
        v_photo_id, v_company, p_property_id, p_flag_id, 'flag', v_retention,
        v_user, v_master, v_thumb, 'image/jpeg',
        v_w, v_h, v_size, 'synced'
      );
    end if;
  end loop;

  return case when v_flag_new then 'created' else 'already_finalized' end;
end;
$$;

grant execute on function public.derive_photo_retention_class(text, text) to authenticated;
grant execute on function public.finalize_flag_with_photos(
  uuid, uuid, uuid, text, text, text, text, jsonb
) to authenticated;
