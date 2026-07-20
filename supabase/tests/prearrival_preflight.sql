-- ============================================================
-- Pre-arrival intents — READ-ONLY PREFLIGHT (run BEFORE applying the migration)
-- ============================================================
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f supabase/tests/prearrival_preflight.sql
--
-- Pure SELECTs. Writes nothing, locks nothing meaningful, changes nothing.
-- Answers: "if I apply 20260718120000 right now, would any live draft
-- pre-arrival pack become unsubmittable?"
--
-- The migration backfills a 'completed' intent for every active photo on a
-- DRAFT pre-arrival pack, then finalise requires each of those to have its
-- original object (and its thumbnail, when the row has one) present in
-- storage. Anything listed by query 3 or 4 below would BLOCK that pack.
--
-- RUNS AGAINST THE CURRENT (pre-migration) SCHEMA. It touches ONLY
-- public.evidence_packs, public.photos, public.properties and storage.objects
-- — it never references photo_upload_intents or any new function, so it is
-- safe (and intended) to run BEFORE the migration is applied.
--
-- Scoped to the Drop-Inn `test` company.
-- ============================================================
\set company_id '1669c464-8d26-40fc-9956-9f8955fd27c7'

\echo '=== 1. Draft pre-arrival packs: photo + backfill overview ==='
select
  ep.id                                            as pack_id,
  ep.company_id,
  ep.property_id,
  p.name                                           as property,
  ep.started_at,
  count(ph.id)                                     as active_photos,
  count(ph.id) filter (where ph.thumbnail_path is null) as photos_without_thumb,
  count(ph.id)                                     as intents_to_backfill,
  case when count(ph.id) = 0 then 'BLOCKED: empty pack' else 'ok' end as empty_check
from public.evidence_packs ep
join public.properties p on p.id = ep.property_id
left join public.photos ph
       on ph.evidence_pack_id = ep.id and ph.deleted_at is null
where ep.company_id = :'company_id'
  and ep.deleted_at is null
  and ep.status = 'draft'
  and ep.pack_type = 'pre_arrival'
group by ep.id, ep.company_id, ep.property_id, p.name, ep.started_at
order by ep.started_at;

\echo ''
\echo '=== 2. Totals ==='
select
  (select count(*) from public.evidence_packs
    where company_id = :'company_id'
      and deleted_at is null and status = 'draft' and pack_type = 'pre_arrival')
    as draft_prearrival_packs,
  (select count(*) from public.photos ph
     join public.evidence_packs ep on ep.id = ph.evidence_pack_id
    where ep.company_id = :'company_id'
      and ph.deleted_at is null and ep.deleted_at is null
      and ep.status = 'draft' and ep.pack_type = 'pre_arrival')
    as photos_to_backfill,
  (select count(*) from public.photos ph
     join public.evidence_packs ep on ep.id = ph.evidence_pack_id
    where ep.company_id = :'company_id'
      and ph.deleted_at is null and ep.deleted_at is null
      and ep.status = 'submitted' and ep.pack_type = 'pre_arrival')
    as submitted_photos_untouched;

\echo ''
\echo '=== 3. BLOCKERS: draft photos whose ORIGINAL object is missing ==='
select ep.id as pack_id, p.name as property, ph.id as photo_id, ph.storage_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
join public.properties p on p.id = ep.property_id
where ep.company_id = :'company_id'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'evidence-photos' and o.name = ph.storage_path
  )
order by ep.id;

\echo ''
\echo '=== 4. BLOCKERS: draft photos whose THUMBNAIL is recorded but missing ==='
select ep.id as pack_id, p.name as property, ph.id as photo_id, ph.thumbnail_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
join public.properties p on p.id = ep.property_id
where ep.company_id = :'company_id'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and ph.thumbnail_path is not null
  and not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'evidence-photos' and o.name = ph.thumbnail_path
  )
order by ep.id;

\echo ''
\echo '=== 5. Draft photos whose path does NOT match the derived scheme ==='
-- companies/{company}/property/{property}/{photo}.jpg — a mismatch means the
-- backfilled intent will not equal what a fresh intent would derive.
select ep.id as pack_id, ph.id as photo_id, ph.storage_path
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
where ep.company_id = :'company_id'
  and ph.deleted_at is null and ep.deleted_at is null
  and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
  and ph.storage_path is distinct from
      format('companies/%s/property/%s/%s.jpg', ph.company_id, ph.property_id, ph.id)
order by ep.id;

\echo ''
\echo '=== 6. Sanity: any photo id already colliding with an existing row? ==='
select count(*) as duplicate_photo_ids
from (
  select id from public.photos group by id having count(*) > 1
) d;

\echo ''
\echo 'INTERPRETATION: queries 3, 4 and 5 must return ZERO rows before applying.'
\echo 'Any row there is a draft pack that would be blocked from submitting;'
\echo 'resolve it (recapture, or discard the pack) BEFORE the migration.'
