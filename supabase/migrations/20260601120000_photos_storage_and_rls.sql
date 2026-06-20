-- ============================================================
-- Migration 0012 — photos: storage bucket + RLS + integrity
-- ============================================================
-- Session 8 — Evidence Camera (flag-level evidence + pre-arrival
-- evidence pack).
--
-- The public.photos table itself was already created in
-- 0001_core_schema.sql with RLS enabled but NO policies or grants.
-- This migration finishes the job:
--   1. Storage bucket `evidence-photos` (private)
--   2. storage.objects policies scoping reads / writes by company,
--      derived from the object path prefix
--   3. public.photos RLS policies (select / insert / update — no
--      hard delete; soft-delete via deleted_at)
--   4. Grants on public.photos to `authenticated`
--   5. Cross-tenant integrity trigger: photos.company_id MUST match
--      the parent flag's company_id when flag_id is set (same belt-
--      and-braces pattern as flag_operational_marks_check_company)
--
-- Path scheme (encoded in storage object name):
--
--   companies/{company_id}/flags/{flag_id}/{photo_id}.jpg
--   companies/{company_id}/flags/{flag_id}/{photo_id}_thumb.jpg
--   companies/{company_id}/property/{property_id}/{photo_id}.jpg
--   companies/{company_id}/property/{property_id}/{photo_id}_thumb.jpg
--
-- The company_id at split_part 2 is the load-bearing piece — the
-- storage policy extracts it and runs the same is_company_member()
-- check the database uses. A leaked anon key STILL cannot read
-- another company's objects because the storage RLS enforces it.
--
-- DELIBERATELY OUT OF SCOPE
--   * No DELETE policy on public.photos (soft-delete only).
--   * No DELETE policy on storage.objects for v1.0 — orphaned
--     objects accumulate until a v1.5 cleanup job ships. Storage
--     cost is dominated by retained photos, not orphans, so this
--     is acceptable.
--   * No role narrowing beyond "is_company_member".
--   * No CHECK constraint on entity_type / retention_class — the
--     vocabulary lives in app code (see PHOTO_AND_EVIDENCE_SYSTEM.md
--     and src/lib/photos/retention.ts).
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Storage bucket
-- ----------------------------------------------------------------
-- Private bucket. 10 MB file size limit (compressed masters target
-- ~400 KB; thumbnails ~30 KB; 10 MB is comfortable headroom and
-- still rejects an accidental uncompressed upload that bypasses the
-- client-side compression module).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence-photos',
  'evidence-photos',
  false,
  10485760,                                    -- 10 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;


-- ----------------------------------------------------------------
-- 2. storage.objects policies (scoped to evidence-photos bucket)
-- ----------------------------------------------------------------
-- Path layout puts company_id as the second segment after the
-- "companies/" prefix:
--   companies/<company_id>/flags/<flag_id>/<photo_id>.jpg
-- split_part(name, '/', 2) extracts <company_id> as text; cast
-- to uuid for is_company_member().
--
-- Note: there are no existing policies on storage.objects from
-- earlier migrations in this project, so no conflict resolution
-- needed. If we add other buckets later, keep their policy names
-- distinct.

create policy "evidence photos: members read company objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'evidence-photos'
    and starts_with(name, 'companies/')
    and public.is_company_member(
      (split_part(name, '/', 2))::uuid
    )
  );

create policy "evidence photos: members insert company objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'evidence-photos'
    and starts_with(name, 'companies/')
    and public.is_company_member(
      (split_part(name, '/', 2))::uuid
    )
  );

create policy "evidence photos: members update company objects"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'evidence-photos'
    and starts_with(name, 'companies/')
    and public.is_company_member(
      (split_part(name, '/', 2))::uuid
    )
  )
  with check (
    bucket_id = 'evidence-photos'
    and starts_with(name, 'companies/')
    and public.is_company_member(
      (split_part(name, '/', 2))::uuid
    )
  );

-- NOTE: No storage.objects DELETE policy. See header comment.


-- ----------------------------------------------------------------
-- 3. public.photos RLS policies
-- ----------------------------------------------------------------
-- SELECT: members read photos in their company. The deleted_at
-- filter is on the application side (most UI surfaces want to
-- hide soft-deleted rows), not RLS — keeps audit / admin views
-- able to see history without policy gymnastics.
create policy "members read company photos"
  on public.photos
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- INSERT: members write photos to their company. Anti-forgery:
-- uploaded_by must equal auth.uid(). This mirrors the
-- flag_operational_marks pattern (marked_by = auth.uid()).
create policy "members insert company photos"
  on public.photos
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and uploaded_by = auth.uid()
  );

-- UPDATE: members update photos in their company. Used for
-- setting deleted_at (soft delete), editing notes, and v1.5
-- bytes_deleted_at when the snapshot-and-purge job runs.
create policy "members update company photos"
  on public.photos
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

-- NOTE: No DELETE policy. Soft-delete via deleted_at.


-- ----------------------------------------------------------------
-- 4. Grants
-- ----------------------------------------------------------------
grant select, insert, update on public.photos to authenticated;


-- ----------------------------------------------------------------
-- 5. Cross-tenant integrity trigger
-- ----------------------------------------------------------------
-- Belt-and-braces guard: photos.company_id MUST match the parent
-- flag's company_id when flag_id is set. The RLS INSERT policy
-- only requires the caller to be a member of company_id; it does
-- NOT verify that flag_id (or property_id, stay_id, etc.) belongs
-- to the same company. Without this trigger, a buggy or malicious
-- client could supply company_id = (user's own company) plus
-- flag_id pointing at a flag in a different company.
--
-- For v1.0 we enforce the check on flag_id only (the only FK
-- exercised this session). The same pattern can extend to
-- inspection_id, issue_id, etc. when those features ship.
-- property_id is intentionally NOT checked because a pre-arrival
-- evidence pack legitimately attaches to a property without a
-- flag, and properties already inherit company_id from RLS.
-- Mismatched property_id would be caught by the RLS SELECT
-- policy at read time (the user would not be able to see the
-- photo across companies even if it landed there).
create or replace function public.photos_check_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_flag_company_id uuid;
  v_property_company_id uuid;
begin
  if NEW.flag_id is not null then
    select company_id into v_flag_company_id
    from public.flags
    where id = NEW.flag_id;

    if v_flag_company_id is null then
      raise exception 'photos: parent flag % not found', NEW.flag_id;
    end if;

    if NEW.company_id is distinct from v_flag_company_id then
      raise exception
        'photos: company_id (%) must match parent flag company_id (%)',
        NEW.company_id, v_flag_company_id;
    end if;
  end if;

  if NEW.property_id is not null then
    select company_id into v_property_company_id
    from public.properties
    where id = NEW.property_id;

    if v_property_company_id is null then
      raise exception 'photos: parent property % not found', NEW.property_id;
    end if;

    if NEW.company_id is distinct from v_property_company_id then
      raise exception
        'photos: company_id (%) must match parent property company_id (%)',
        NEW.company_id, v_property_company_id;
    end if;
  end if;

  return NEW;
end;
$$;

create trigger trg_photos_check_company
  before insert or update on public.photos
  for each row execute function public.photos_check_company();


-- ----------------------------------------------------------------
-- 6. Helpful index for the Action Centre photo-count badge
-- ----------------------------------------------------------------
-- The Action Centre renders a "📷 N" chip on each flag card by
-- counting photos per flag. There is already an index on flag_id
-- (idx_photos_flag_id, migration 0003), so the count query
-- (`select flag_id, count(*) ... where flag_id in (...) and
-- deleted_at is null`) is fast. No new index needed.
--
-- For the pre-arrival pack we filter by (property_id,
-- retention_class, captured_at) which is already covered by
-- idx_photos_property_retention_captured (also migration 0003).
