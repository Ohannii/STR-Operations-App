-- ============================================================
-- Pre-arrival intents - READ-ONLY PREFLIGHT (Supabase SQL Editor version)
-- ============================================================
-- Same checks as prearrival_preflight.sql, but with NO psql meta-commands
-- (no \set, no \echo, no \timing), so it can be pasted straight into the
-- Supabase SQL Editor. The company UUID is inlined as a literal instead of
-- a psql variable. ASCII only, to avoid any encoding mangling.
--
-- Run this BEFORE applying migration 20260718120000.
--
-- SAFETY
--   * Pure SELECTs. Writes nothing, changes nothing, locks nothing.
--   * Uses ONLY the CURRENT schema: public.evidence_packs, public.photos,
--     public.properties, storage.objects. It never references
--     photo_upload_intents or any new function, so it is safe to run before
--     the migration exists.
--   * Scoped to the Drop-Inn "test" company: 1669c464-8d26-40fc-9956-9f8955fd27c7
--
-- HOW TO USE
--   Run each numbered block separately (the SQL Editor returns one result
--   grid per statement). Queries 3, 4 and 5 MUST return zero rows before the
--   migration is applied. Any row there is a live draft pack that would be
--   blocked from submitting - resolve it first (recapture, or discard the
--   pack).
-- ============================================================


-- ------------------------------------------------------------
-- 1. Draft pre-arrival packs: photo + backfill overview
-- ------------------------------------------------------------
select
  ep.id                                                 as pack_id,
  ep.company_id,
  ep.property_id,
  p.name                                                as property,
  ep.started_at,
  count(ph.id)                                          as active_photos,
  count(ph.id) filter (where ph.thumbnail_path is null) as photos_without_thumb,
  count(ph.id)                                          as intents_to_backfill,
  case when count(ph.id) = 0 then 'BLOCKED: empty pack' else 'ok' end as empty_check
from public.evidence_packs ep
join public.properties p on p.id = ep.property_id
left join public.photos ph
       on ph.evidence_pack_id = ep.id and ph.deleted_at is null
where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
  and ep.deleted_at is null
  and ep.status = 'draft'
  and ep.pack_type = 'pre_arrival'
group by ep.id, ep.company_id, ep.property_id, p.name, ep.started_at
order by ep.started_at;


-- ------------------------------------------------------------
-- 2. Totals (all three scoped to the test company)
-- ------------------------------------------------------------
select
  (select count(*) from public.evidence_packs
    where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
      and deleted_at is null and status = 'draft' and pack_type = 'pre_arrival')
    as draft_prearrival_packs,
  (select count(*) from public.photos ph
     join public.evidence_packs ep on ep.id = ph.evidence_pack_id
    where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
      and ph.deleted_at is null and ep.deleted_at is null
      and ep.status = 'draft' and ep.pack_type = 'pre_arrival')
    as photos_to_backfill,
  (select count(*) from public.photos ph
     join public.evidence_packs ep on ep.id = ph.evidence_pack_id
    where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
      and ph.deleted_at is null and ep.deleted_at is null
      and ep.status = 'submitted' and ep.pack_type = 'pre_arrival')
    as submitted_photos_untouched;


-- ------------------------------------------------------------
-- 3. BLOCKERS: draft photos whose ORIGINAL object is missing
--    MUST return zero rows.
-- ------------------------------------------------------------
select ep.id as pack_id, p.name as property, ph.id as photo_id, ph.storage_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
join public.properties p on p.id = ep.property_id
where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'evidence-photos' and o.name = ph.storage_path
  )
order by ep.id;


-- ------------------------------------------------------------
-- 4. BLOCKERS: draft photos whose THUMBNAIL is recorded but missing
--    MUST return zero rows.
-- ------------------------------------------------------------
select ep.id as pack_id, p.name as property, ph.id as photo_id, ph.thumbnail_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
join public.properties p on p.id = ep.property_id
where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and ph.thumbnail_path is not null
  and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'evidence-photos' and o.name = ph.thumbnail_path
  )
order by ep.id;


-- ------------------------------------------------------------
-- 5. Draft photos whose path does NOT match the derived scheme
--    companies/{company}/property/{property}/{photo}.jpg
--    A mismatch means the backfilled intent would not equal what a fresh
--    intent derives. MUST return zero rows.
-- ------------------------------------------------------------
select ep.id as pack_id, ph.id as photo_id, ph.storage_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and ph.storage_path is distinct from
      format('companies/%s/property/%s/%s.jpg', ph.company_id, ph.property_id, ph.id)
order by ep.id;


-- ------------------------------------------------------------
-- 6. Sanity: any duplicate photo ids anywhere?
-- ------------------------------------------------------------
select count(*) as duplicate_photo_ids
from (
  select id from public.photos group by id having count(*) > 1
) d;
