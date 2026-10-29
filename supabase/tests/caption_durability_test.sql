-- ============================================================
-- P0 CAPTION DURABILITY acceptance tests (rev 5, 27 Oct 2026)
-- ============================================================
-- Run:  pnpm.cmd exec supabase db query --linked -f supabase/tests/caption_durability_test.sql
-- (Requires explicit approval to run against the linked database.)
--
-- SELF-CONTAINED and SIDE-EFFECT-FREE: applies migration 20261022090000
-- INSIDE this transaction, builds fixtures through the REAL intent->attach
-- pipeline, runs the acceptance orderings, prints ONE verdict row, ROLLS BACK.
--
-- TEST INTEGRITY (rev 3+): the block between the INLINE MIGRATION markers is
-- the migration file VERBATIM. src/lib/photos/caption-sql-sync.test.ts fails
-- if it ever differs by a single character, so this suite cannot test SQL
-- other than what would be applied. Regenerate the block from the migration
-- file — never hand-edit it.
begin;

-- >>> BEGIN INLINE MIGRATION 20261022090000 (verbatim — do not edit)
-- ============================================================
-- P0 CAPTION DURABILITY (22 Oct 2026; rev 3, 23 Oct after release review)
-- ============================================================
-- DO NOT APPLY without explicit approval (project rule).
--
-- INCIDENT (Unit 377, 21 Oct 2026): the draft pack report rendered one
-- independent "Save caption" form per photo plus a separate Submit button.
-- Typing captions and pressing Submit finalised the pack while 40 captions
-- existed only in the DOM — they never reached the server, and the pack then
-- became immutable.
--
-- WHAT THIS MIGRATION PROVIDES
--   0. caption_canonical(text) — THE one caption normalization rule, used for
--      every comparison (incoming note, expected baseline, stored
--      photos.notes, submitted replay): strip leading/trailing ASCII
--      whitespace (space, \t, \n, \r, \f, \v); empty means NULL. It mirrors
--      src/lib/photos/caption-canonical.ts exactly. Stored legacy values are
--      COMPARED canonically but never rewritten unless the caption changes.
--   1. set_prearrival_photo_caption(photo, note, expected)
--      Audited COMPARE-AND-SET autosave for draft packs. The expected value
--      is MANDATORY and ALWAYS compared — there is no flag or default that
--      could request a blind overwrite (rev 4). A caller whose expected value
--      no longer matches the server gets 'stale' with zero writes.
--   2. submit_prearrival_pack_with_captions(pack, manifest jsonb)
--      ONE transaction, TWO PASSES (rev 3):
--        pass 1 (no writes): lock the pack; parse the manifest; lock every
--          referenced photo; prove the manifest covers EVERY active photo
--          exactly once; compare EVERY entry's expected_note with the
--          current server caption. Any baseline mismatch returns
--          'caption_conflict' having written NOTHING;
--        pass 2 (only after pass 1 fully succeeds): apply caption changes,
--          write audit history, run the EXISTING finalize_prearrival_pack
--          invariants verbatim, then write the submit audit.
--      Any raise anywhere rolls back every write of the transaction.
--   3. The legacy direct client grant on finalize_prearrival_pack is
--      revoked: the caption transaction is the only user-reachable way to
--      submit a pre-arrival pack (the SECURITY DEFINER function still calls
--      it as owner).
--
-- HARDENING: both new SECURITY DEFINER functions use `set search_path = ''`
-- and fully schema-qualify every non-builtin reference (pg_catalog builtins
-- are always resolved). No dynamic SQL. auth.uid() required. Company
-- membership, pack/property scope and draft status are checked under the
-- pack row lock. Inputs are bounded (2000 chars per caption, 500 manifest
-- entries). The audit actor is auth.uid() — never a client value. EXECUTE
-- is revoked from PUBLIC and anon and granted to authenticated only.
--
-- Already enforced by migration 20260718120000 and RELIED ON here (unchanged):
--   * photos_prearrival_pack_guard: photos of a SUBMITTED pre-arrival pack
--     are immutable — captions cannot change after submission, on any path.
--   * Clients hold update(notes, deleted_at) only; evidence_pack_id is not
--     client-writable; finalize_prearrival_pack owns the status transition.
--
--   5. (rev 5) attach_prearrival_photo is redefined with ONE change: an
--      over-limit caption is REFUSED (22023) instead of silently truncated
--      with left(..., 2000), and the canonical rule replaces its ad-hoc
--      btrim. Every other line is the 20260718120000 body, verbatim.
--   6. (rev 5) photos.notes gets a NOT VALID length CHECK (<= 2,000
--      characters): enforced for every NEW write on every path, including the
--      direct client update(notes) grant, without touching existing rows.
--
-- No existing data is modified. The recovered Unit 377 rows are untouched.

-- ----------------------------------------------------------------
-- 0. caption_canonical — THE caption normalization rule
-- ----------------------------------------------------------------
-- chr(11) is the vertical tab: E'' strings do not support \v (it would be a
-- literal 'v'), so it is appended explicitly.
create or replace function public.caption_canonical(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    pg_catalog.btrim(coalesce(p_text, ''), E' \t\n\r\f' || pg_catalog.chr(11)),
    ''
  )
$$;
revoke all on function public.caption_canonical(text) from public;
revoke all on function public.caption_canonical(text) from anon;
revoke all on function public.caption_canonical(text) from authenticated;

-- The pre-review 4-argument autosave (with a bypass flag) was never applied
-- anywhere; drop it defensively so no blind-overwrite signature can exist.
drop function if exists public.set_prearrival_photo_caption(uuid, text, text, boolean);

-- ----------------------------------------------------------------
-- 1. set_prearrival_photo_caption — audited COMPARE-AND-SET autosave
-- ----------------------------------------------------------------
-- Returns 'saved' | 'unchanged' | 'stale'. Raises (typed) on scope/state
-- violations and on a missing expected value. Lock order matches every other
-- pack RPC: PACK first, then photo.
create or replace function public.set_prearrival_photo_caption(
  p_photo_id       uuid,
  p_note           text,
  p_expected_notes text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack     uuid;
  v_company  uuid;
  v_status   text;
  v_type     text;
  v_prop_co  uuid;
  v_property uuid;
  v_old      text;
  v_old_c    text;
  v_new      text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_expected_notes is null then
    -- MANDATORY compare-and-set baseline ('' = expected blank). No bypass.
    raise exception 'expected caption is required' using errcode = '22023';
  end if;
  if (p_note is not null and length(p_note) > 2000) or length(p_expected_notes) > 2000 then
    raise exception 'caption is too long (max 2000)' using errcode = '22023';
  end if;

  -- Resolve the pack WITHOUT locking the photo yet (lock order: pack first).
  select ph.evidence_pack_id into v_pack
  from public.photos ph
  where ph.id = p_photo_id and ph.deleted_at is null;
  if not found then
    raise exception 'photo % not found', p_photo_id using errcode = 'P0002';
  end if;
  if v_pack is null then
    raise exception 'photo % is not part of a pre-arrival pack', p_photo_id
      using errcode = '22023';
  end if;

  -- (1) Lock the pack; it must be a DRAFT pre-arrival pack in scope.
  select ep.company_id, ep.property_id, ep.status, ep.pack_type
    into v_company, v_property, v_status, v_type
  from public.evidence_packs ep
  where ep.id = v_pack and ep.deleted_at is null
  for update;
  if v_company is null then
    raise exception 'evidence pack % not found', v_pack using errcode = 'P0002';
  end if;
  if v_type <> 'pre_arrival' then
    raise exception 'pack % is not a pre-arrival pack', v_pack using errcode = '22023';
  end if;
  if v_status = 'submitted' then
    raise exception 'caption_locked: this pack was submitted and is immutable'
      using errcode = '42501';
  end if;
  if v_status <> 'draft' then
    raise exception 'pack % is not a draft', v_pack using errcode = '22023';
  end if;
  select p.company_id into v_prop_co
  from public.properties p where p.id = v_property and p.deleted_at is null;
  if v_prop_co is null or v_prop_co is distinct from v_company then
    raise exception 'pack % property scope mismatch', v_pack using errcode = '23514';
  end if;
  if not public.is_company_member(v_company) then
    raise exception 'not a member of the owning company' using errcode = '42501';
  end if;

  -- (2) Lock the photo and re-verify it still belongs to this pack.
  select ph.notes into v_old
  from public.photos ph
  where ph.id = p_photo_id and ph.deleted_at is null
    and ph.evidence_pack_id = v_pack
  for update;
  if not found then
    raise exception 'photo % is not an active photo of pack %', p_photo_id, v_pack
      using errcode = '23514';
  end if;

  -- One canonical rule for every comparison (blank-by-choice => NULL).
  v_old_c := public.caption_canonical(v_old);
  v_new := public.caption_canonical(p_note);
  if v_new is not distinct from v_old_c then
    return 'unchanged'; -- nothing to write (legacy raw whitespace untouched)
  end if;

  -- (3) COMPARE-AND-SET under the row lock — UNCONDITIONAL.
  if public.caption_canonical(p_expected_notes) is distinct from v_old_c then
    return 'stale';
  end if;

  update public.photos set notes = v_new where id = p_photo_id;

  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, before, after, metadata)
  values
    (v_company, auth.uid(), 'photo_caption_update', 'photo', p_photo_id,
     jsonb_build_object('notes', v_old),
     jsonb_build_object('notes', v_new),
     jsonb_build_object('evidence_pack_id', v_pack, 'property_id', v_property,
                        'source', 'autosave'));

  return 'saved';
end;
$$;

-- ----------------------------------------------------------------
-- 2. submit_prearrival_pack_with_captions — two-pass atomic save-and-submit
-- ----------------------------------------------------------------
-- p_captions: jsonb array of
--   {"photo_id": uuid, "note": string|null, "expected_note": string}
-- covering EVERY active photo of the pack exactly once. `expected_note` is
-- the server caption the client's text was written against (its baseline).
--
-- Returns 'submitted' | 'already_submitted' | 'caption_conflict'.
--   * draft pack, any baseline mismatch    -> 'caption_conflict', ZERO writes;
--   * submitted pack, identical captions   -> 'already_submitted' (lost-
--                                             response replay), zero writes;
--   * submitted pack, different captions   -> 'caption_conflict', zero writes.
-- Raises (rolling back everything) on malformed / oversize / duplicate /
-- unknown / deleted / cross-pack / incomplete manifests, and on any
-- finalize_prearrival_pack invariant failure.
create or replace function public.submit_prearrival_pack_with_captions(
  p_pack_id  uuid,
  p_captions jsonb default '[]'::jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_property uuid;
  v_status   text;
  v_type     text;
  v_prop_co  uuid;
  v_item     jsonb;
  v_photo    uuid;
  v_note     text;
  v_expect   text;
  v_old      text;
  v_changes  jsonb := '[]'::jsonb;
  v_ids      uuid[] := '{}';
  v_notes    text[] := '{}';
  v_expected text[] := '{}';
  v_current  text[] := '{}';
  v_raw      text[] := '{}';
  v_n        int;
  v_i        int;
  v_active   int;
  v_result   text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_captions is null or jsonb_typeof(p_captions) <> 'array' then
    raise exception 'captions payload must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_captions) > 500 then
    raise exception 'captions payload too large (max 500 entries)' using errcode = '22023';
  end if;

  -- (0) EXCLUSIVE pack lock for the WHOLE operation (same lock order as
  -- finalize_prearrival_pack, which re-locks the same row in this txn).
  select ep.company_id, ep.property_id, ep.status, ep.pack_type
    into v_company, v_property, v_status, v_type
  from public.evidence_packs ep
  where ep.id = p_pack_id and ep.deleted_at is null
  for update;
  if v_company is null then
    raise exception 'evidence pack % not found', p_pack_id using errcode = 'P0002';
  end if;
  if v_type <> 'pre_arrival' then
    raise exception 'pack % is not a pre-arrival pack', p_pack_id using errcode = '22023';
  end if;
  select p.company_id into v_prop_co
  from public.properties p where p.id = v_property and p.deleted_at is null;
  if v_prop_co is null or v_prop_co is distinct from v_company then
    raise exception 'pack % property scope mismatch', p_pack_id using errcode = '23514';
  end if;
  if not public.is_company_member(v_company) then
    raise exception 'not a member of the owning company' using errcode = '42501';
  end if;
  if v_status not in ('draft', 'submitted') then
    raise exception 'pack % is in an unexpected state (%)', p_pack_id, v_status
      using errcode = '22023';
  end if;

  -- Parse + validate the WHOLE manifest shape (both branches).
  for v_item in select * from jsonb_array_elements(p_captions)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ? 'photo_id')
       or not (v_item ? 'expected_note') then
      raise exception 'malformed caption entry' using errcode = '22023';
    end if;
    begin
      v_photo := (v_item ->> 'photo_id')::uuid;
    exception when others then
      raise exception 'malformed caption photo id' using errcode = '22023';
    end;
    if v_photo = any (v_ids) then
      raise exception 'duplicate caption entry for photo %', v_photo
        using errcode = '22023';
    end if;
    if v_item ? 'note' and jsonb_typeof(v_item -> 'note') not in ('string', 'null') then
      raise exception 'malformed caption note' using errcode = '22023';
    end if;
    if jsonb_typeof(v_item -> 'expected_note') <> 'string' then
      raise exception 'malformed caption baseline' using errcode = '22023';
    end if;
    -- RAW length FIRST (rev 5): 2,001 whitespace characters must not slip
    -- through by canonicalizing to blank. Over-limit input is refused.
    if length(coalesce(v_item ->> 'note', '')) > 2000
       or length(coalesce(v_item ->> 'expected_note', '')) > 2000 then
      raise exception 'caption is too long (max 2000)' using errcode = '22023';
    end if;
    v_note := public.caption_canonical(v_item ->> 'note');
    v_expect := public.caption_canonical(v_item ->> 'expected_note');
    v_ids := v_ids || v_photo;
    v_notes := array_append(v_notes, v_note);
    v_expected := array_append(v_expected, v_expect);
  end loop;
  v_n := coalesce(array_length(v_ids, 1), 0);

  -- SUBMITTED pack: replay vs conflict by exact comparison. ZERO writes.
  if v_status = 'submitted' then
    for v_i in 1 .. v_n
    loop
      select ph.notes into v_old
      from public.photos ph
      where ph.id = v_ids[v_i] and ph.deleted_at is null
        and ph.evidence_pack_id = p_pack_id;
      if not found or v_notes[v_i] is distinct from public.caption_canonical(v_old) then
        return 'caption_conflict';
      end if;
    end loop;
    select count(*) into v_active
    from public.photos ph
    where ph.evidence_pack_id = p_pack_id and ph.deleted_at is null;
    if v_active is distinct from v_n then
      return 'caption_conflict';
    end if;
    return 'already_submitted';
  end if;

  -- ============ PASS 1 (DRAFT): validate EVERYTHING, write NOTHING =========
  -- Lock every referenced photo; each must be an ACTIVE photo of THIS pack.
  for v_i in 1 .. v_n
  loop
    select ph.notes into v_old
    from public.photos ph
    where ph.id = v_ids[v_i] and ph.deleted_at is null
      and ph.evidence_pack_id = p_pack_id
    for update;
    if not found then
      raise exception
        'photo % is not an active photo of this pack — nothing was submitted',
        v_ids[v_i] using errcode = '23514';
    end if;
    v_raw := array_append(v_raw, v_old);
    v_current := array_append(v_current, public.caption_canonical(v_old));
  end loop;

  -- COMPLETE-MANIFEST PROOF: every supplied id is a distinct active photo of
  -- this pack (above), so equal counts <=> every active photo appears once.
  select count(*) into v_active
  from public.photos ph
  where ph.evidence_pack_id = p_pack_id and ph.deleted_at is null;
  if v_active is distinct from v_n then
    raise exception
      'caption_manifest_incomplete: pack has % active photos but % were supplied — reload the report and try again',
      v_active, v_n using errcode = '23514';
  end if;

  -- COMPARE-AND-SET over the WHOLE manifest before any write (canonical
  -- rule on both sides): if any caption changed since the client's baseline
  -- (another tab/device), stop
  -- here — nothing has been written, so no partial caption update can exist.
  for v_i in 1 .. v_n
  loop
    if v_expected[v_i] is distinct from v_current[v_i] then
      return 'caption_conflict';
    end if;
  end loop;

  -- ============ PASS 2 (DRAFT): apply, audit, finalise =====================
  for v_i in 1 .. v_n
  loop
    if v_notes[v_i] is distinct from v_current[v_i] then
      update public.photos set notes = v_notes[v_i] where id = v_ids[v_i];
      v_changes := v_changes || jsonb_build_object(
        'photo_id', v_ids[v_i], 'before', v_raw[v_i], 'after', v_notes[v_i]);
    end if;
  end loop;

  -- Recoverable caption history (insert-only table; actor is auth.uid()).
  -- Rolls back with the transaction if finalisation below raises.
  if jsonb_array_length(v_changes) > 0 then
    insert into public.audit_events
      (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
    values
      (v_company, auth.uid(), 'photo_caption_batch_update', 'evidence_pack',
       p_pack_id,
       jsonb_build_object('property_id', v_property,
                          'changed_count', jsonb_array_length(v_changes),
                          'changes', v_changes,
                          'source', 'submit'));
  end if;

  -- The EXISTING finalisation invariants, verbatim, same transaction.
  v_result := public.finalize_prearrival_pack(p_pack_id);

  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, before, after, metadata)
  values
    (v_company, auth.uid(), 'evidence_pack_submit', 'evidence_pack', p_pack_id,
     jsonb_build_object('status', 'draft'),
     jsonb_build_object('status', 'submitted', 'outcome', v_result),
     jsonb_build_object('property_id', v_property,
                        'captions_supplied', v_n,
                        'captions_changed', jsonb_array_length(v_changes)));

  return v_result;
end;
$$;

-- ----------------------------------------------------------------
-- 2b. attach_prearrival_photo — REFUSE over-limit captions (rev 5)
-- ----------------------------------------------------------------
-- Identical to the 20260718120000 definition except the caption handling:
--   was:  v_note := left(nullif(btrim(coalesce(p_note, '')), ''), 2000);
--   now:  raw length > 2000 raises 22023 (nothing written; the client keeps
--         the queued photo and its full caption); v_note := caption_canonical.
-- `create or replace` keeps the existing EXECUTE grants unchanged.
create or replace function public.attach_prearrival_photo(
  p_photo_id    uuid,
  p_width       int,
  p_height      int,
  p_size_bytes  int,
  p_captured_at timestamptz,
  p_note        text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack   uuid;
  v_intent public.photo_upload_intents%rowtype;
  v_photo  public.photos%rowtype;
  v_note   text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- CAPTION LIMIT (rev 5): refuse, never truncate — checked on the RAW value
  -- before any lock or write.
  if p_note is not null and length(p_note) > 2000 then
    raise exception 'caption is too long (max 2000)' using errcode = '22023';
  end if;

  -- (1) Resolve the pack WITHOUT a lock so we can take locks in order.
  select evidence_pack_id into v_pack
  from public.photo_upload_intents where id = p_photo_id;
  if v_pack is null then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;

  -- (2) Lock the pack SHARED (blocks finalise, allows sibling attaches).
  perform 1 from public.evidence_packs where id = v_pack for share;

  -- (3) Authorise against CURRENT pack state (live draft, caller is a member).
  perform 1 from public.assert_draft_prearrival_pack(v_pack);

  -- (4) Now lock the intent itself.
  select * into v_intent from public.photo_upload_intents
  where id = p_photo_id
  for update;
  if not found then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;
  if v_intent.state = 'discarded' then
    raise exception 'photo intent % was discarded', p_photo_id using errcode = '22023';
  end if;
  if v_intent.evidence_pack_id is distinct from v_pack then
    raise exception 'photo intent % changed pack mid-flight', p_photo_id
      using errcode = '23514';
  end if;

  if p_width is null or p_height is null or p_size_bytes is null
     or p_width <= 0 or p_width > 20000
     or p_height <= 0 or p_height > 20000
     or p_size_bytes <= 0 or p_size_bytes > 10485760 then
    raise exception 'photo dimensions/size out of range' using errcode = '22023';
  end if;

  -- STORAGE INTEGRITY: the exact derived objects must exist before a row is
  -- recorded, so a photos row can never exist without its bytes.
  perform 1 from storage.objects
   where bucket_id = 'evidence-photos' and name = v_intent.master_path;
  if not found then
    raise exception 'evidence master object missing for photo %', p_photo_id
      using errcode = '23514';
  end if;
  if v_intent.thumb_path is not null then
    perform 1 from storage.objects
     where bucket_id = 'evidence-photos' and name = v_intent.thumb_path;
    if not found then
      raise exception 'evidence thumbnail object missing for photo %', p_photo_id
        using errcode = '23514';
    end if;
  end if;

  v_note := public.caption_canonical(p_note);

  select * into v_photo from public.photos where id = p_photo_id;
  if found then
    -- Relationship-verified replay (lost response). Mismatch fails closed.
    if v_photo.deleted_at is not null then
      raise exception 'photo % was deleted; cannot re-attach', p_photo_id
        using errcode = '23505';
    end if;
    if v_photo.company_id       is distinct from v_intent.company_id
       or v_photo.property_id      is distinct from v_intent.property_id
       or v_photo.evidence_pack_id is distinct from v_intent.evidence_pack_id
       or v_photo.storage_path     is distinct from v_intent.master_path
       or v_photo.thumbnail_path   is distinct from v_intent.thumb_path then
      raise exception 'photo % already exists with different data', p_photo_id
        using errcode = '23505';
    end if;
  else
    insert into public.photos (
      id, company_id, property_id, evidence_pack_id, entity_type,
      retention_class, uploaded_by, captured_at, storage_path, thumbnail_path,
      mime_type, width, height, size_bytes, notes, sync_status
    ) values (
      p_photo_id, v_intent.company_id, v_intent.property_id,
      v_intent.evidence_pack_id, 'property',
      'routine_pre_arrival', auth.uid(), p_captured_at,
      v_intent.master_path, v_intent.thumb_path,
      'image/jpeg', p_width, p_height, p_size_bytes, v_note, 'synced'
    );
  end if;

  if v_intent.state = 'completed' then
    return 'already_completed';
  end if;

  update public.photo_upload_intents
     set state = 'completed', completed_at = now()
   where id = p_photo_id;

  return 'completed';
end;
$$;

-- ----------------------------------------------------------------
-- 2c. photos.notes length guard on EVERY new write (rev 5)
-- ----------------------------------------------------------------
-- NOT VALID: existing rows are not re-checked (no data is touched); every
-- INSERT/UPDATE from now on is. Covers the direct client update(notes)
-- grant as well as every RPC.
alter table public.photos
  add constraint photos_notes_max_2000
  check (notes is null or char_length(notes) <= 2000) not valid;

-- ----------------------------------------------------------------
-- 3. Grants (authorisation happens INSIDE each function)
-- ----------------------------------------------------------------
revoke all on function public.set_prearrival_photo_caption(uuid, text, text) from public;
revoke all on function public.set_prearrival_photo_caption(uuid, text, text) from anon;
revoke all on function public.submit_prearrival_pack_with_captions(uuid, jsonb) from public;
revoke all on function public.submit_prearrival_pack_with_captions(uuid, jsonb) from anon;
grant execute on function public.set_prearrival_photo_caption(uuid, text, text) to authenticated;
grant execute on function public.submit_prearrival_pack_with_captions(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------
-- 4. CLOSE THE LEGACY SUBMIT BYPASS
-- ----------------------------------------------------------------
-- finalize_prearrival_pack was directly executable by any authenticated
-- client, which let a manipulated request finalise a draft pre-arrival pack
-- WITHOUT the caption manifest. The caption-aware submit function is now the
-- only user-reachable finalisation path: it is SECURITY DEFINER (owner-run),
-- so revoking the client grant does not affect its internal call.
revoke execute on function public.finalize_prearrival_pack(uuid) from authenticated;
revoke all on function public.finalize_prearrival_pack(uuid) from public;
revoke all on function public.finalize_prearrival_pack(uuid) from anon;
-- <<< END INLINE MIGRATION 20261022090000

-- ---- harness ----
create temporary table _chk (n serial, label text, pass boolean) on commit drop;
create or replace function pg_temp.chk(p_label text, p_pass boolean)
returns void language sql as $$ insert into _chk (label, pass) values (p_label, p_pass) $$;
create or replace function pg_temp.must_fail(p_label text, p_sql text, p_code text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_label || '  (NOT REJECTED)', false);
  exception when others then
    perform pg_temp.chk(p_label || '  [' || sqlstate || ']',
                        p_code is null or sqlstate = p_code or sqlerrm like p_code || '%');
  end;
end $$;
create or replace function pg_temp.act_as(p_user uuid, p_email text)
returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'email', p_email, 'role', 'authenticated')::text, true);
$$;
-- Build one COMPLETED photo on a pack through the REAL intent->attach path.
create or replace function pg_temp.mk_photo(p_pack uuid)
returns uuid language plpgsql as $$
declare
  v_pid uuid := gen_random_uuid();
  v_master text; v_thumb text; v_res text;
begin
  select i.master_path, i.thumb_path into v_master, v_thumb
  from public.create_prearrival_photo_intent(p_pack, v_pid) i;
  insert into storage.objects (bucket_id, name, metadata)
  values ('evidence-photos', v_master, jsonb_build_object('size', 1234)),
         ('evidence-photos', v_thumb,  jsonb_build_object('size', 99));
  select public.attach_prearrival_photo(v_pid, 100, 100, 1000, now(), null) into v_res;
  if v_res not in ('completed', 'already_completed') then
    raise exception 'fixture attach failed: %', v_res;
  end if;
  return v_pid;
end $$;
-- Intent + storage objects for a photo, WITHOUT attaching (rev 5 length tests).
create or replace function pg_temp.mk_intent(p_pack uuid)
returns uuid language plpgsql as $$
declare
  v_pid uuid := gen_random_uuid();
  v_master text; v_thumb text;
begin
  select i.master_path, i.thumb_path into v_master, v_thumb
  from public.create_prearrival_photo_intent(p_pack, v_pid) i;
  insert into storage.objects (bucket_id, name, metadata)
  values ('evidence-photos', v_master, jsonb_build_object('size', 1234)),
         ('evidence-photos', v_thumb,  jsonb_build_object('size', 99));
  return v_pid;
end $$;
-- One manifest entry: note + the baseline it was written against.
create or replace function pg_temp.e(p_photo uuid, p_note text, p_expected text)
returns jsonb language sql as $$
  select jsonb_build_object('photo_id', p_photo, 'note', p_note, 'expected_note', p_expected)
$$;
-- Audit rows for a pack/photo, for zero-write proofs.
create or replace function pg_temp.audit_count(p_entity uuid)
returns int language sql as $$
  select count(*)::int from public.audit_events where entity_id = p_entity
$$;

do $$
declare
  v_company uuid; -- resolved dynamically below (rev 5: never a hard-coded id)
  v_member uuid; v_member_email text;
  outsider uuid := gen_random_uuid();
  v_prop uuid; v_prop2 uuid; v_prop3 uuid; v_prop4 uuid;
  pack1 uuid; pack2 uuid; pack3 uuid; pack4 uuid;
  q1 uuid; q2 uuid; q3 uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid;
  deadp uuid := gen_random_uuid();
  v_res text; v_n int; v_audit_before int; v_pending uuid := gen_random_uuid();
begin
  -- FIXTURE (rev 5): resolve a real company AND one of its active members
  -- dynamically. The earlier hard-coded UUID was a company_memberships row id,
  -- not a company id. Everything below runs inside the rolled-back txn.
  select cm.company_id, cm.user_id, p.email
    into v_company, v_member, v_member_email
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id
  join public.profiles p on p.id = cm.user_id
  where cm.is_active and cm.deleted_at is null
  order by cm.created_at, cm.id
  limit 1;
  if v_company is null or v_member is null then
    raise exception 'ABORTED: no company with an active member exists in this database — create one (via the app) before running this suite';
  end if;

  insert into auth.users (id, email) values (outsider, 'caption-outsider@test.local');
  insert into public.profiles (id, email) values (outsider, 'caption-outsider@test.local')
  on conflict (id) do update set email = excluded.email;

  -- ONE property per draft pack (at most one draft pre-arrival pack per property).
  insert into public.properties (company_id, name)
  values (v_company, 'CAPTION-TEST-ROLLBACK-1') returning id into v_prop;
  insert into public.properties (company_id, name)
  values (v_company, 'CAPTION-TEST-ROLLBACK-2') returning id into v_prop2;
  insert into public.properties (company_id, name)
  values (v_company, 'CAPTION-TEST-ROLLBACK-3') returning id into v_prop3;
  insert into public.evidence_packs (company_id, property_id, pack_type, title, started_by)
  values (v_company, v_prop, 'pre_arrival', 'caption test pack 1', v_member)
  returning id into pack1;
  insert into public.evidence_packs (company_id, property_id, pack_type, title, started_by)
  values (v_company, v_prop2, 'pre_arrival', 'caption test pack 2', v_member)
  returning id into pack2;

  -- A soft-DELETED, unlinked photo row (pack photos cannot be deleted by DB
  -- construction, so the deleted case is an unlinked deleted row).
  insert into public.photos
    (id, company_id, property_id, entity_type, retention_class, uploaded_by,
     uploaded_at, storage_path, mime_type, deleted_at)
  values
    (deadp, v_company, v_prop, 'property', 'routine_pre_arrival', v_member,
     now(), 'companies/' || v_company || '/deleted-test.jpg', 'image/jpeg', now());

  perform pg_temp.act_as(v_member, coalesce(v_member_email, 'member@test.local'));

  p1 := pg_temp.mk_photo(pack1);
  p2 := pg_temp.mk_photo(pack1);
  p3 := pg_temp.mk_photo(pack1);
  p4 := pg_temp.mk_photo(pack2);

  -- ============ P. privileges + hardening (blockers 7/10) ===================
  perform pg_temp.chk('P1: caption autosave executable by authenticated only',
    has_function_privilege('authenticated',
      'public.set_prearrival_photo_caption(uuid,text,text)', 'execute')
    and not has_function_privilege('anon',
      'public.set_prearrival_photo_caption(uuid,text,text)', 'execute'));
  perform pg_temp.chk('P2: save-and-submit executable by authenticated only',
    has_function_privilege('authenticated',
      'public.submit_prearrival_pack_with_captions(uuid,jsonb)', 'execute')
    and not has_function_privilege('anon',
      'public.submit_prearrival_pack_with_captions(uuid,jsonb)', 'execute'));
  perform pg_temp.chk('P3: LEGACY BYPASS CLOSED - finalize not client-executable',
    not has_function_privilege('authenticated',
      'public.finalize_prearrival_pack(uuid)', 'execute')
    and not has_function_privilege('anon',
      'public.finalize_prearrival_pack(uuid)', 'execute'));
  perform pg_temp.chk('P4: both new functions are SECURITY DEFINER with search_path=""',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_prearrival_photo_caption', 'submit_prearrival_pack_with_captions')
       and p.prosecdef
       and p.proconfig @> array['search_path=""']) = 2);
  perform pg_temp.chk('P5: NO bypass signature: the autosave exists only as (uuid,text,text)',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_prearrival_photo_caption') = 1
    and (select p.pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'set_prearrival_photo_caption') = 3
    and (select p.pronargdefaults from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'set_prearrival_photo_caption') = 0);
  perform pg_temp.chk('P6: caption_canonical is internal (not client-executable)',
    not has_function_privilege('authenticated', 'public.caption_canonical(text)', 'execute')
    and not has_function_privilege('anon', 'public.caption_canonical(text)', 'execute'));
  perform pg_temp.chk('P7: canonical rule = ASCII-whitespace trim, blank => NULL, never eats a letter v',
    public.caption_canonical(E' \t\n\r\f' || chr(11) || 'vase v' || chr(11) || E'\n ') = 'vase v'
    and public.caption_canonical('   ') is null
    and public.caption_canonical(null) is null
    and public.caption_canonical('v') = 'v');

  -- ============ A. audited COMPARE-AND-SET autosave =========================
  v_res := public.set_prearrival_photo_caption(p1, 'Entrance door locks', '');
  perform pg_temp.chk('A1: autosave saves (' || v_res || ')',
    v_res = 'saved'
    and (select notes from public.photos where id = p1) = 'Entrance door locks');
  perform pg_temp.chk('A1b: audit row with before/after + actor',
    exists (select 1 from public.audit_events
            where event_kind = 'photo_caption_update' and entity_id = p1
              and actor_id = v_member
              and before ->> 'notes' is null
              and after ->> 'notes' = 'Entrance door locks'));
  v_res := public.set_prearrival_photo_caption(p1, 'Entrance door locks', 'Entrance door locks');
  select count(*) into v_n from public.audit_events
  where event_kind = 'photo_caption_update' and entity_id = p1;
  perform pg_temp.chk('A2: identical save is unchanged, no duplicate audit (' || v_res || ')',
    v_res = 'unchanged' and v_n = 1);
  v_res := public.set_prearrival_photo_caption(p1, 'late tab overwrite', 'what old tab saw');
  perform pg_temp.chk('A3: STALE caller refused, newer server text intact (' || v_res || ')',
    v_res = 'stale'
    and (select notes from public.photos where id = p1) = 'Entrance door locks');
  v_res := public.set_prearrival_photo_caption(p1, '  ', 'Entrance door locks');
  perform pg_temp.chk('A4: blank-by-choice with correct expectation stores NULL (' || v_res || ')',
    v_res = 'saved'
    and (select notes is null from public.photos where id = p1));
  v_res := public.set_prearrival_photo_caption(p1, 'Entrance door locks', '');
  perform pg_temp.chk('A5: caption restored for the submit tests', v_res = 'saved');
  perform pg_temp.must_fail('A6: an OMITTED expectation cannot write (no 2-arg form exists)',
    format('select public.set_prearrival_photo_caption(%L::uuid, %L::text)', p1, 'blind overwrite'),
    '42883');
  perform pg_temp.must_fail('A7: a NULL expectation cannot write',
    format('select public.set_prearrival_photo_caption(%L, %L, null)', p1, 'blind overwrite'),
    '22023');
  perform pg_temp.must_fail('A8: the old 4-arg bypass form does not exist',
    format('select public.set_prearrival_photo_caption(%L, %L, null, false)', p1, 'blind overwrite'),
    '42883');
  perform pg_temp.chk('A9: none of the bypass attempts wrote anything',
    (select notes from public.photos where id = p1) = 'Entrance door locks');

  -- ============ B. authority / cross-company ===============================
  perform pg_temp.act_as(outsider, 'caption-outsider@test.local');
  perform pg_temp.must_fail('B1: non-member cannot autosave a caption',
    format('select public.set_prearrival_photo_caption(%L, %L, %L)', p2, 'x', ''),
    '42501');
  perform pg_temp.must_fail('B2: non-member cannot save-and-submit',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, '[]'), '42501');
  perform pg_temp.act_as(v_member, coalesce(v_member_email, 'member@test.local'));

  -- ============ C. fail-closed manifest validation ==========================
  perform pg_temp.must_fail('C1: unknown photo id fails closed',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
             pg_temp.e(p2, '', ''), pg_temp.e(p3, '', ''),
             pg_temp.e(gen_random_uuid(), 'x', ''))::text),
    '23514');
  perform pg_temp.must_fail('C2: CROSS-PACK (foreign) photo id fails closed',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
             pg_temp.e(p2, '', ''), pg_temp.e(p3, '', ''),
             pg_temp.e(p4, 'stolen', ''))::text),
    '23514');
  perform pg_temp.must_fail('C3: DELETED photo id fails closed',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
             pg_temp.e(p2, '', ''), pg_temp.e(p3, '', ''),
             pg_temp.e(deadp, 'dead', ''))::text),
    '23514');
  perform pg_temp.must_fail('C4: OMITTED active photo fails closed (incomplete manifest)',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
             pg_temp.e(p2, 'b', ''))::text),
    'caption_manifest_incomplete');
  perform pg_temp.must_fail('C5: duplicate photo entries rejected',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             pg_temp.e(p1, 'a', 'Entrance door locks'),
             pg_temp.e(p1, 'b', 'Entrance door locks'),
             pg_temp.e(p3, 'c', ''))::text),
    '22023');
  perform pg_temp.must_fail('C6: non-array payload rejected',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, '"nope"'), '22023');
  perform pg_temp.must_fail('C7: entry WITHOUT a baseline (expected_note) rejected',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack1, jsonb_build_array(
             jsonb_build_object('photo_id', p1, 'note', 'a'),
             pg_temp.e(p2, '', ''), pg_temp.e(p3, '', ''))::text),
    '22023');
  perform pg_temp.chk('C8: every rejected submit wrote NOTHING (draft, captions intact)',
    (select status from public.evidence_packs where id = pack1) = 'draft'
    and (select notes from public.photos where id = p1) = 'Entrance door locks'
    and (select notes is null from public.photos where id = p2)
    and (select notes is null from public.photos where id = p3)
    and (select notes is null from public.photos where id = p4));

  -- ============ G. submit COMPARE-AND-SET (blocker 4) =======================
  -- Another device changes p2 between this device's autosave and its submit.
  v_res := public.set_prearrival_photo_caption(p2, 'Other device text', '');
  perform pg_temp.chk('G0: other device autosaves p2 (' || v_res || ')', v_res = 'saved');
  v_audit_before := pg_temp.audit_count(pack1);
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
    pg_temp.e(p2, 'This device text', ''),           -- stale baseline ('')
    pg_temp.e(p3, 'Geyser valve closed', '')));
  perform pg_temp.chk('G1: stale baseline => caption_conflict (' || v_res || ')',
    v_res = 'caption_conflict');
  perform pg_temp.chk('G1b: ZERO caption writes (p2 keeps other device text, p3 untouched)',
    (select notes from public.photos where id = p2) = 'Other device text'
    and (select notes is null from public.photos where id = p3));
  perform pg_temp.chk('G1c: ZERO audit writes and ZERO status change',
    pg_temp.audit_count(pack1) = v_audit_before
    and (select status from public.evidence_packs where id = pack1) = 'draft');
  -- Two-pass proof: the mismatch is on a LATER entry, after an earlier entry
  -- that WOULD change — the earlier change must not commit.
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p3, 'early change that must not commit', ''),
    pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
    pg_temp.e(p2, 'x', 'wrong baseline')));
  perform pg_temp.chk('G2: later-entry conflict cannot commit an earlier update (' || v_res || ')',
    v_res = 'caption_conflict'
    and (select notes is null from public.photos where id = p3));

  -- ============ D. finalisation failure rolls captions AND audit back =======
  insert into public.evidence_packs (company_id, property_id, pack_type, title, started_by)
  values (v_company, v_prop3, 'pre_arrival', 'caption test pack 3', v_member)
  returning id into pack3;
  p5 := pg_temp.mk_photo(pack3);
  perform public.create_prearrival_photo_intent(pack3, v_pending); -- stays pending
  perform pg_temp.must_fail('D1: unresolved intent blocks submit',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack3, jsonb_build_array(pg_temp.e(p5, 'should roll back', ''))::text),
    null);
  perform pg_temp.chk('D1b: caption write AND batch audit ROLLED BACK with the failed submit',
    (select status from public.evidence_packs where id = pack3) = 'draft'
    and (select notes is null from public.photos where id = p5)
    and not exists (select 1 from public.audit_events
                    where event_kind = 'photo_caption_batch_update'
                      and entity_id = pack3));

  -- ============ E. atomic submit from expected OLD values to NEW values ====
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'), -- unchanged
    pg_temp.e(p2, '', 'Other device text'),                      -- old -> blank by choice
    pg_temp.e(p3, 'Geyser valve closed', '')));                  -- blank -> new
  perform pg_temp.chk('E1: atomic old->new save-and-submit succeeds (' || v_res || ')',
    v_res = 'submitted');
  perform pg_temp.chk('E1b: every caption persisted exactly (blank stays a chosen blank)',
    (select notes from public.photos where id = p1) = 'Entrance door locks'
    and (select notes is null from public.photos where id = p2)
    and (select notes from public.photos where id = p3) = 'Geyser valve closed');
  perform pg_temp.chk('E1c: pack submitted with identity',
    (select status = 'submitted' and submitted_by = v_member and submitted_at is not null
     from public.evidence_packs where id = pack1));
  perform pg_temp.chk('E1d: batch caption audit (before/after + actor) + submit audit',
    exists (select 1 from public.audit_events
            where event_kind = 'photo_caption_batch_update' and entity_id = pack1
              and actor_id = v_member
              and metadata -> 'changes' @> jsonb_build_array(
                    jsonb_build_object('photo_id', p3, 'before', null,
                                       'after', 'Geyser valve closed'))
              and metadata -> 'changes' @> jsonb_build_array(
                    jsonb_build_object('photo_id', p2, 'before', 'Other device text',
                                       'after', null)))
    and exists (select 1 from public.audit_events
                where event_kind = 'evidence_pack_submit' and entity_id = pack1
                  and actor_id = v_member));

  -- ============ F. replay vs conflict on a SUBMITTED pack ===================
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p1, 'Entrance door locks', 'Entrance door locks'),
    pg_temp.e(p2, '', 'Other device text'),
    pg_temp.e(p3, 'Geyser valve closed', '')));
  perform pg_temp.chk('F1: identical-manifest lost-response replay is already_submitted (' || v_res || ')',
    v_res = 'already_submitted');
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p1, 'OTHER DEVICE TEXT', 'Entrance door locks'),
    pg_temp.e(p2, '', ''),
    pg_temp.e(p3, 'Geyser valve closed', '')));
  perform pg_temp.chk('F2: different captions => caption_conflict, nothing mutated (' || v_res || ')',
    v_res = 'caption_conflict'
    and (select notes from public.photos where id = p1) = 'Entrance door locks');
  v_res := public.submit_prearrival_pack_with_captions(pack1, jsonb_build_array(
    pg_temp.e(p3, 'Geyser valve closed', '')));
  perform pg_temp.chk('F3: partial-manifest replay => caption_conflict (' || v_res || ')',
    v_res = 'caption_conflict');
  perform pg_temp.must_fail('F4: autosave on a submitted pack is refused',
    format('select public.set_prearrival_photo_caption(%L, %L, %L)', p3, 'late edit', 'Geyser valve closed'),
    'caption_locked');
  perform pg_temp.must_fail('F5: even a direct notes UPDATE is blocked by the trigger',
    format('update public.photos set notes = %L where id = %L', 'bypass', p3),
    null);
  perform pg_temp.chk('F6: caption history retained (audit rows intact)',
    (select count(*) from public.audit_events
     where event_kind in ('photo_caption_update', 'photo_caption_batch_update')) >= 2);

  -- ============ L. LEGACY whitespace: one canonical rule end to end =========
  update public.photos set notes = E'  Legacy caption \n' where id = p4; -- legacy raw value
  v_res := public.set_prearrival_photo_caption(p4, 'Legacy caption', 'Legacy caption');
  perform pg_temp.chk('L1: canonically equal autosave is unchanged, raw legacy value untouched (' || v_res || ')',
    v_res = 'unchanged'
    and (select notes from public.photos where id = p4) = E'  Legacy caption \n');
  v_res := public.submit_prearrival_pack_with_captions(pack2, jsonb_build_array(
    pg_temp.e(p4, 'Legacy caption', 'Legacy caption')));
  perform pg_temp.chk('L2: legacy whitespace baseline is NOT a conflict; submit succeeds (' || v_res || ')',
    v_res = 'submitted'
    and (select notes from public.photos where id = p4) = E'  Legacy caption \n');
  v_res := public.submit_prearrival_pack_with_captions(pack2, jsonb_build_array(
    pg_temp.e(p4, ' Legacy caption', 'Legacy caption')));
  perform pg_temp.chk('L3: replay compares canonically => already_submitted, deterministic (' || v_res || ')',
    v_res = 'already_submitted');

  -- ============ T. 2,000-character limit: REFUSE, never truncate (rev 5) ====
  insert into public.properties (company_id, name)
  values (v_company, 'CAPTION-TEST-ROLLBACK-4') returning id into v_prop4;
  insert into public.evidence_packs (company_id, property_id, pack_type, title, started_by)
  values (v_company, v_prop4, 'pre_arrival', 'caption test pack 4', v_member)
  returning id into pack4;
  q1 := pg_temp.mk_intent(pack4);
  perform pg_temp.must_fail('T1: attach with a 2,001-char caption is REFUSED',
    format('select public.attach_prearrival_photo(%L, 100, 100, 1000, now(), %L)',
           q1, repeat('x', 2001)),
    '22023');
  perform pg_temp.chk('T1b: refused attach wrote NOTHING (no photo row; intent still pending)',
    not exists (select 1 from public.photos where id = q1)
    and (select state from public.photo_upload_intents where id = q1) = 'pending');
  v_res := public.attach_prearrival_photo(q1, 100, 100, 1000, now(), repeat('x', 2000));
  perform pg_temp.chk('T2: exactly 2,000 chars is accepted and stored in FULL (' || v_res || ')',
    v_res = 'completed'
    and (select char_length(notes) from public.photos where id = q1) = 2000);
  q2 := pg_temp.mk_intent(pack4);
  v_res := public.attach_prearrival_photo(q2, 100, 100, 1000, now(), E'  padded caption \n');
  perform pg_temp.chk('T3: attach uses THE canonical rule (' || v_res || ')',
    (select notes from public.photos where id = q2) = 'padded caption');
  q3 := pg_temp.mk_intent(pack4);
  perform pg_temp.must_fail('T4: 2,001 WHITESPACE chars are refused at attach (raw length first)',
    format('select public.attach_prearrival_photo(%L, 100, 100, 1000, now(), %L)',
           q3, repeat(' ', 2001)),
    '22023');
  v_res := public.attach_prearrival_photo(q3, 100, 100, 1000, now(), null);
  v_audit_before := pg_temp.audit_count(pack4);
  perform pg_temp.must_fail('T5: submit NOTE of 2,001 spaces refused (no canonical bypass)',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack4, jsonb_build_array(
             pg_temp.e(q1, repeat('x', 2000), repeat('x', 2000)),
             pg_temp.e(q2, 'padded caption', 'padded caption'),
             pg_temp.e(q3, repeat(' ', 2001), ''))::text),
    '22023');
  perform pg_temp.must_fail('T6: submit EXPECTED of 2,001 spaces refused (no canonical bypass)',
    format('select public.submit_prearrival_pack_with_captions(%L, %L::jsonb)',
           pack4, jsonb_build_array(
             pg_temp.e(q1, repeat('x', 2000), repeat('x', 2000)),
             pg_temp.e(q2, 'padded caption', 'padded caption'),
             pg_temp.e(q3, 'x', repeat(' ', 2001)))::text),
    '22023');
  perform pg_temp.chk('T7: the refused submits wrote NOTHING (captions, audit, status)',
    (select notes is null from public.photos where id = q3)
    and pg_temp.audit_count(pack4) = v_audit_before
    and (select status from public.evidence_packs where id = pack4) = 'draft');
  perform pg_temp.must_fail('T8: a direct notes write over 2,000 chars violates the CHECK',
    format('update public.photos set notes = %L where id = %L', repeat('y', 2001), q3),
    '23514');
  perform pg_temp.chk('T9: autosave of 2,001 spaces is refused too',
    (select count(*) = 0 from public.audit_events
     where entity_id = q3 and event_kind = 'photo_caption_update'));
  perform pg_temp.must_fail('T9b: autosave raw-length guard',
    format('select public.set_prearrival_photo_caption(%L, %L, %L)', q3, repeat(' ', 2001), ''),
    '22023');
end $$;

select
  case when count(*) filter (where not pass) = 0
       then 'CAPTION TESTS (rev 5): ALL ' || count(*) || ' PASS (rolled back)'
       else 'CAPTION TESTS (rev 5): ' || count(*) filter (where not pass) || ' FAILED of ' || count(*)
  end as verdict,
  string_agg(case when not pass then label end, ' | ') as failures
from _chk;

rollback;
