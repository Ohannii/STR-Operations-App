-- ============================================================
-- Pre-arrival intents - READ-ONLY PREFLIGHT (plain SQL, no psql commands)
-- ============================================================
-- Run BEFORE applying migration 20260718120000.
--
--   pnpm.cmd exec supabase db query --linked -f supabase/tests/prearrival_preflight.sql
--
-- This file is ORDINARY SQL only. It contains no backslash meta-commands
-- (set, echo, if, timing) and no colon-prefixed variable placeholders: those
-- are psql-only and `supabase db query` rejects them at parse time. The test
-- company UUID is written as a literal in every query instead. It also pastes
-- straight into the Supabase SQL Editor. ASCII only, so nothing can be
-- mangled by encoding.
--
-- SAFETY
--   * Pure SELECTs. Writes nothing, changes nothing, locks nothing.
--   * CURRENT schema only: public.evidence_packs, public.photos,
--     public.properties, storage.objects. Nothing here references the new
--     intents table or any new function, so it is safe to run before the
--     migration exists.
--   * Scoped in EVERY query to the Drop-Inn "test" company
--     1669c464-8d26-40fc-9956-9f8955fd27c7
--
-- HOW TO READ IT
--   Query 7 is the verdict: ONE row with the anomaly counts from queries 3-6
--   plus a READY / BLOCKED result. Every count must be 0 before the migration
--   is applied. Because it is the LAST statement, a client that only surfaces
--   the final result set still gives a definitive go / no-go answer.
--
--   Queries 3, 4 and 5 list the offending rows individually, so if query 7
--   reports BLOCKED you can see exactly which photos to resolve (recapture
--   the photo, or discard the pack). Run a numbered block on its own if you
--   need just that detail.
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


-- ------------------------------------------------------------
-- 7. SUMMARY - the single row that decides go / no-go
--    Re-counts the anomalies from queries 3-6 in one place, so a client that
--    only surfaces the LAST result set still gives a definitive answer.
--    Every count must be 0 before the migration is applied.
-- ------------------------------------------------------------
with blockers as (
  select
    -- 3. draft photos whose ORIGINAL object is missing
    (select count(*)
       from public.photos ph
       join public.evidence_packs ep on ep.id = ph.evidence_pack_id
      where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
        and ph.deleted_at is null and ep.deleted_at is null
        and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
        and not exists (
          select 1 from storage.objects o
          where o.bucket_id = 'evidence-photos' and o.name = ph.storage_path
        )
    ) as missing_original_objects,

    -- 4. draft photos whose THUMBNAIL is recorded but missing
    (select count(*)
       from public.photos ph
       join public.evidence_packs ep on ep.id = ph.evidence_pack_id
      where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
        and ph.deleted_at is null and ep.deleted_at is null
        and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
        and ph.thumbnail_path is not null
        and not exists (
          select 1 from storage.objects o
          where o.bucket_id = 'evidence-photos' and o.name = ph.thumbnail_path
        )
    ) as missing_thumbnails,

    -- 5. draft photos whose path does not match the derived scheme
    (select count(*)
       from public.photos ph
       join public.evidence_packs ep on ep.id = ph.evidence_pack_id
      where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
        and ph.deleted_at is null and ep.deleted_at is null
        and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
        and ph.storage_path is distinct from
            format('companies/%s/property/%s/%s.jpg',
                   ph.company_id, ph.property_id, ph.id)
    ) as non_conforming_paths,

    -- 6. duplicate photo ids among this company's draft pre-arrival photos
    (select count(*) from (
        select ph.id
          from public.photos ph
          join public.evidence_packs ep on ep.id = ph.evidence_pack_id
         where ep.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
           and ph.deleted_at is null and ep.deleted_at is null
           and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
         group by ph.id
        having count(*) > 1
      ) dupes
    ) as duplicate_photo_ids
)
select
  missing_original_objects,
  missing_thumbnails,
  non_conforming_paths,
  duplicate_photo_ids,
  (missing_original_objects + missing_thumbnails
   + non_conforming_paths + duplicate_photo_ids) as total_blockers,
  case
    when (missing_original_objects + missing_thumbnails
          + non_conforming_paths + duplicate_photo_ids) = 0
    then 'READY - no blockers found'
    else 'BLOCKED - resolve the rows listed in queries 3-6 before applying the migration'
  end as verdict
from blockers;
