-- ============================================================
-- report-artifacts: private, system-written PDF bucket
-- ============================================================
-- Slice 11C1. Stores generated report PDFs (flag reports, submitted
-- pack/pre-arrival reports). PR2 reuses the same artifacts for Asana.
--
-- Access model — deliberately SYSTEM-WRITTEN and PRIVATE:
--   * No storage.objects policies for `authenticated` or `anon`, so end
--     users have NO direct insert/update/delete/select on this bucket.
--   * `service_role` bypasses RLS entirely, so trusted server code (the
--     prepare routes, after they authorize the user) generates + writes
--     the artifact and mints a short-lived signed download URL.
--   * End users only ever read via that signed URL — never a policy.
--
-- This mirrors the "system-written" intent: authenticated users can never
-- create, alter, or overwrite an official report artifact.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-artifacts',
  'report-artifacts',
  false,
  26214400,                        -- 25 MB (a 5-photo master PDF is a few MB)
  array['application/pdf']
)
on conflict (id) do nothing;

-- NOTE: intentionally NO policies on storage.objects for this bucket.
-- authenticated/anon get deny-by-default; service_role bypasses RLS.
