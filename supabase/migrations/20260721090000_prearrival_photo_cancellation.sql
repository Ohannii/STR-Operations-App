-- ============================================================
-- Pre-arrival photo cancellation tombstone + slot/finalise lock fix
-- ============================================================
-- DO NOT APPLY without explicit approval (project rule).
--
-- WHY THIS EXISTS
--
-- (1) REMOVAL RACE. Upload-early staging creates the upload intent at capture
-- time. When an inspector removes a photo, the client cannot know whether its
-- own slot request is still in flight (delayed radio, old tab). Previously,
-- discarding a photo with no intent raised P0002, the client deleted its local
-- record, and a DELAYED slot request could then create a fresh pending intent
-- for a removed photo — an orphan that blocks submission. Client ordering
-- checks cannot close a race between two server arrivals; only the database
-- can. Discard therefore now ALWAYS leaves a durable state='discarded' row —
-- updating the existing intent or inserting a preemptive TOMBSTONE — and slot
-- creation / attach already reject state='discarded' atomically on the PK row.
--
-- (2) SLOT-vs-FINALISE RACE (found in review). create_prearrival_photo_intent
-- called assert_draft_prearrival_pack WITHOUT holding the pack lock. A delayed
-- slot request could verify "draft", pause, let finalize_prearrival_pack
-- submit the pack (FOR UPDATE), and then insert a pending intent into a
-- SUBMITTED pack. Fixed by taking the evidence_packs FOR SHARE lock BEFORE
-- authorisation and holding it through the insert — FOR SHARE conflicts with
-- finalise's FOR UPDATE, so the orderings serialise: either the slot request
-- commits first (finalise then sees its intent) or finalise commits first
-- (the draft re-check fails). Same fix applied to the tombstone path.
--
-- LOCK ORDER (unchanged, now actually honoured everywhere):
--     1. public.evidence_packs        (FOR SHARE; finalise takes FOR UPDATE)
--     2. public.photo_upload_intents  (FOR UPDATE / PK insert)
--
-- THE INVARIANT (server-owned, keyed by the photo uuid PK):
--   * Discard always leaves durable 'discarded' (tombstone if needed).
--   * Slot creation rejects 'discarded' and rejects non-draft packs UNDER LOCK.
--   * Attach rejects 'discarded' under FOR UPDATE.
--   * ATTACH-WINS is a legal ordering: if attach commits first, discard finds
--     'completed' and raises 22023 'already saved…' — the photo IS attached
--     evidence; the client reconciles it as attached (terminal, visible).
--   * Repeat discards return 'already_discarded' (idempotent).
-- ============================================================

-- ----------------------------------------------------------------
-- 1. create_prearrival_photo_intent — now locks the pack FOR SHARE
-- ----------------------------------------------------------------
-- CREATE OR REPLACE (same signature) preserves the existing ACL. All identity,
-- collision, replay and discarded-state checks preserved verbatim; the ONLY
-- change is taking the pack lock before authorisation.
create or replace function public.create_prearrival_photo_intent(
  p_pack_id  uuid,
  p_photo_id uuid
)
returns table (photo_id uuid, company_id uuid, master_path text, thumb_path text, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company   uuid;
  v_property  uuid;
  v_master    text;
  v_thumb     text;
  v_existing  public.photo_upload_intents%rowtype;
  v_photo_id  uuid;
begin
  if p_photo_id is null then
    raise exception 'photo id is required' using errcode = '22023';
  end if;

  -- LOCK FIRST (fix for the slot-vs-finalise race): hold the pack FOR SHARE
  -- so finalise (FOR UPDATE) cannot submit the pack between our draft check
  -- and our insert. Row-absence falls through to the assert, which raises
  -- the canonical error.
  perform 1 from public.evidence_packs where id = p_pack_id for share;

  select a.company_id, a.property_id into v_company, v_property
  from public.assert_draft_prearrival_pack(p_pack_id) a;

  -- Paths are DERIVED (mirrors src/lib/photos/paths.ts). The second segment
  -- must remain the company id — the storage.objects policies depend on it.
  v_master := format('companies/%s/property/%s/%s.jpg', v_company, v_property, p_photo_id);
  v_thumb  := format('companies/%s/property/%s/%s_thumb.jpg', v_company, v_property, p_photo_id);

  select * into v_existing from public.photo_upload_intents where id = p_photo_id;
  if found then
    -- Relationship-verified replay: EVERY identity field must match.
    if v_existing.company_id        is distinct from v_company
       or v_existing.property_id      is distinct from v_property
       or v_existing.evidence_pack_id is distinct from p_pack_id
       or v_existing.master_path      is distinct from v_master
       or v_existing.thumb_path       is distinct from v_thumb then
      raise exception 'photo intent % already exists with different identity', p_photo_id
        using errcode = '23505';
    end if;
    if v_existing.state = 'discarded' then
      raise exception 'photo intent % was discarded; capture a new photo', p_photo_id
        using errcode = '22023';
    end if;
    photo_id := p_photo_id; company_id := v_company;
    master_path := v_master; thumb_path := v_thumb; state := v_existing.state;
    return next;
    return;
  end if;

  -- Collision guard: never issue a slot for an id already used by a photo row
  -- (would risk overwriting existing evidence).
  select ph.id into v_photo_id from public.photos ph where ph.id = p_photo_id;
  if v_photo_id is not null then
    raise exception 'photo id % is already in use', p_photo_id using errcode = '23505';
  end if;

  insert into public.photo_upload_intents (
    id, company_id, property_id, evidence_pack_id,
    master_path, thumb_path, state, created_by
  ) values (
    p_photo_id, v_company, v_property, p_pack_id,
    v_master, v_thumb, 'pending', auth.uid()
  );

  photo_id := p_photo_id; company_id := v_company;
  master_path := v_master; thumb_path := v_thumb; state := 'pending';
  return next;
end;
$$;


-- ----------------------------------------------------------------
-- 2. discard_prearrival_photo_intent — tombstone + correct locking
-- ----------------------------------------------------------------
-- Signature change: (photo, reason) -> (photo, reason, pack default null).
-- The old two-argument function is DROPPED so exactly one function exists
-- (a second overload would make PostgREST named-argument dispatch ambiguous).
drop function if exists public.discard_prearrival_photo_intent(uuid, text);

create function public.discard_prearrival_photo_intent(
  p_photo_id uuid,
  p_reason   text,
  p_pack_id  uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack     uuid;
  v_company  uuid;
  v_property uuid;
  v_intent   public.photo_upload_intents%rowtype;
  v_reason   text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_photo_id is null then
    raise exception 'photo id is required' using errcode = '22023';
  end if;
  v_reason := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  if v_reason is null then
    raise exception 'a discard reason is required' using errcode = '22023';
  end if;

  select evidence_pack_id into v_pack
  from public.photo_upload_intents where id = p_photo_id;

  -- Caller-supplied pack must agree with reality. A client that believes the
  -- photo belongs to a different pack is confused; fail closed, never
  -- cross-discard.
  if v_pack is not null and p_pack_id is not null
     and v_pack is distinct from p_pack_id then
    raise exception 'photo % belongs to a different pack', p_photo_id
      using errcode = '23505';
  end if;

  if v_pack is null then
    -- No intent yet. Without a pack we cannot authorise or place a tombstone.
    if p_pack_id is null then
      raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
    end if;

    -- LOCK FIRST, then authorise (same order and reason as slot creation):
    -- FOR SHARE blocks finalise while we decide, so a tombstone can never be
    -- inserted into a pack that just submitted.
    perform 1 from public.evidence_packs where id = p_pack_id for share;
    select a.company_id, a.property_id into v_company, v_property
    from public.assert_draft_prearrival_pack(p_pack_id) a;

    -- PREEMPTIVE TOMBSTONE. Same derived paths as create_prearrival_photo_intent
    -- so a replayed slot request passes its relationship check and then fails
    -- closed on state='discarded'. PK-serialised against a concurrent create:
    -- exactly one row wins; we re-read and verify it below either way.
    insert into public.photo_upload_intents (
      id, company_id, property_id, evidence_pack_id,
      master_path, thumb_path, state, created_by,
      discarded_at, discarded_by, discard_reason
    ) values (
      p_photo_id, v_company, v_property, p_pack_id,
      format('companies/%s/property/%s/%s.jpg', v_company, v_property, p_photo_id),
      format('companies/%s/property/%s/%s_thumb.jpg', v_company, v_property, p_photo_id),
      'discarded', auth.uid(),
      now(), auth.uid(), v_reason
    )
    on conflict (id) do nothing;

    -- Whoever won the PK race, the row must belong to EXACTLY this
    -- company/property/pack before we touch it further. A mismatched winner
    -- (foreign identity) is never updated — fail closed.
    select * into v_intent from public.photo_upload_intents where id = p_photo_id;
    if not found then
      raise exception 'could not record cancellation for photo %', p_photo_id
        using errcode = 'P0001';
    end if;
    if v_intent.company_id        is distinct from v_company
       or v_intent.property_id      is distinct from v_property
       or v_intent.evidence_pack_id is distinct from p_pack_id then
      raise exception 'photo % belongs to a different pack', p_photo_id
        using errcode = '23505';
    end if;
    v_pack := v_intent.evidence_pack_id;
  end if;

  -- Normal audited-discard path (also finishes the tombstone-vs-create race:
  -- if a concurrent create won the insert, we discard its pending intent
  -- here, under the same locks).
  perform 1 from public.evidence_packs where id = v_pack for share;
  perform 1 from public.assert_draft_prearrival_pack(v_pack);

  select * into v_intent from public.photo_upload_intents
  where id = p_photo_id
  for update;
  if not found then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;

  if v_intent.state = 'discarded' then
    -- Includes the tombstone we may have just inserted. Idempotent.
    return 'already_discarded';
  end if;
  if v_intent.state = 'completed' then
    -- ATTACH WON the ordering. The photo is attached evidence; discard does
    -- not pretend otherwise. Clients reconcile this as terminal-attached.
    raise exception 'photo % is already saved and cannot be discarded here', p_photo_id
      using errcode = '22023';
  end if;

  update public.photo_upload_intents
     set state = 'discarded',
         discarded_at = now(),
         discarded_by = auth.uid(),
         discard_reason = v_reason
   where id = p_photo_id;

  return 'discarded';
end;
$$;

comment on function public.discard_prearrival_photo_intent(uuid, text, uuid) is
  'Audited abandon of a promised pre-arrival photo. With p_pack_id, also writes '
  'a preemptive cancellation tombstone (under the pack FOR SHARE lock) when no '
  'intent exists yet, so delayed or replayed slot requests fail closed instead '
  'of resurrecting a removed photo.';

-- ----------------------------------------------------------------
-- 3. Permissions — a NEW function grants EXECUTE to PUBLIC by default
-- ----------------------------------------------------------------
revoke all on function public.discard_prearrival_photo_intent(uuid, text, uuid)
  from public;
grant execute on function public.discard_prearrival_photo_intent(uuid, text, uuid)
  to authenticated;
