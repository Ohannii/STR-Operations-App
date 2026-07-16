-- ============================================================
-- photos: service-role SELECT grant
-- ============================================================
-- The new-flag photo flow's collision guard (checkFlagPhotoCollision,
-- called from requestFlagPhotoUploadSlot) runs as `service_role` so it
-- can see soft-deleted / cross-company rows that user RLS would hide.
-- service_role bypasses RLS, but Postgres still requires a table-level
-- GRANT — and migration 0012 (photos_storage_and_rls) granted
-- public.photos only to `authenticated`, not service_role. Without this
-- the guard's `select id from public.photos` fails with permission
-- denied and every new-flag photo upload errors out before signing.
--
-- Additive, grants-only. SELECT only. No grant to `anon`. No change to
-- `authenticated` privileges, RLS, Storage policies, or any other table.

grant select on table public.photos to service_role;
