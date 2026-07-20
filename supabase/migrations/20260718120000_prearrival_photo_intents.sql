-- ============================================================
-- Pre-arrival photo upload intents — Outcome 2 (durable, server-authoritative)
-- ============================================================
-- WHY THIS EXISTS
--
-- Pre-arrival packs accumulate photos across multiple capture sessions and are
-- submitted later, so (unlike the one-shot flag flow) the server had NO durable
-- record of a photo that was PROMISED to a pack but never landed. The only
-- trace was the public.photos row, which exists only if BOTH the upload and the
-- attach succeeded. That gap allowed a pack to be submitted with zero (or
-- partial) evidence when uploads failed silently — the Unit 407 incident.
--
-- This migration issues an INTENT before any upload URL is handed out, and then
-- proves a BIDIRECTIONAL invariant inside one transaction at submit time:
--     every non-discarded intent  -> exactly one active photo (+ objects)
--     every active pack photo     -> exactly one completed intent
-- The second direction is what closes the "old attach path / stale client"
-- bypass: a photo written by any legacy or direct route has no intent and
-- therefore BLOCKS finalisation.
--
-- It also removes the direct draft -> submitted bypass by taking table-wide
-- UPDATE away from clients (see section 6): only the SECURITY DEFINER
-- finalize_prearrival_pack() can move a pack to 'submitted'.
--
-- Client state (localStorage / in-memory) is UX only and never authoritative.
-- No cron, no polling, no new service, no new dependency.
--
-- LOCK ORDER (deadlock avoidance) — always acquire in this order:
--     1. public.evidence_packs        (FOR SHARE in attach/discard, FOR UPDATE in finalise)
--     2. public.photo_upload_intents  (FOR UPDATE)
-- Attach/discard take a SHARE lock on the pack so they may run concurrently
-- with each other but are mutually exclusive with finalise, which takes the
-- exclusive lock. Nothing acquires these in the reverse order.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------
create table public.photo_upload_intents (
  -- The LOGICAL photo id. Becomes public.photos.id when completed.
  id                uuid primary key,
  company_id        uuid not null references public.companies(id)      on delete cascade,
  property_id       uuid not null references public.properties(id)     on delete cascade,
  evidence_pack_id  uuid not null references public.evidence_packs(id) on delete cascade,
  -- Exact expected Storage object keys (derived, never client-supplied).
  master_path       text not null,
  -- Nullable ONLY to allow the legacy backfill (a handful of historical draft
  -- photos predate thumbnails). Every intent this migration's RPCs create
  -- always carries both keys.
  thumb_path        text,
  state             text not null default 'pending',
  -- Audit trail.
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  discarded_at      timestamptz,
  discarded_by      uuid references public.profiles(id),
  discard_reason    text,

  constraint photo_upload_intents_state_chk
    check (state in ('pending', 'completed', 'discarded')),

  -- Terminal states must carry their audit fields. A discard REQUIRES a reason.
  constraint photo_upload_intents_state_audit_chk check (
    (state <> 'completed' or completed_at is not null)
    and (
      state <> 'discarded'
      or (discarded_at is not null
          and discarded_by is not null
          and length(btrim(coalesce(discard_reason, ''))) > 0)
    )
  ),

  constraint photo_upload_intents_paths_chk check (
    length(btrim(master_path)) > 0
    and (thumb_path is null
         or (length(btrim(thumb_path)) > 0 and thumb_path <> master_path))
  )
);

comment on table public.photo_upload_intents is
  'Server-issued intent for a pre-arrival pack photo. Written only by the '
  'prearrival RPCs. Makes empty/partial pack submission impossible.';


-- ----------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------
create index idx_photo_upload_intents_pack_state
  on public.photo_upload_intents (evidence_pack_id, state);

create index idx_photo_upload_intents_company_id
  on public.photo_upload_intents (company_id);

-- One intent may own a given Storage object.
create unique index idx_photo_upload_intents_master_path
  on public.photo_upload_intents (master_path);


-- ----------------------------------------------------------------
-- 3. updated_at trigger (reuses the project helper)
-- ----------------------------------------------------------------
create trigger trg_photo_upload_intents_set_updated_at
  before update on public.photo_upload_intents
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------
-- 4. Cross-tenant integrity trigger (belt-and-braces)
-- ----------------------------------------------------------------
create or replace function public.photo_upload_intents_check_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pack_company  uuid;
  v_pack_property uuid;
  v_prop_company  uuid;
begin
  select company_id, property_id into v_pack_company, v_pack_property
  from public.evidence_packs where id = new.evidence_pack_id;
  if v_pack_company is null then
    raise exception 'evidence pack % not found', new.evidence_pack_id
      using errcode = 'P0002';
  end if;

  select company_id into v_prop_company
  from public.properties where id = new.property_id;
  if v_prop_company is null then
    raise exception 'property % not found', new.property_id using errcode = 'P0002';
  end if;

  if new.company_id is distinct from v_pack_company
     or new.company_id is distinct from v_prop_company
     or new.property_id is distinct from v_pack_property then
    raise exception 'photo_upload_intents company/property/pack mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_photo_upload_intents_check_company
  before insert or update on public.photo_upload_intents
  for each row execute function public.photo_upload_intents_check_company();


-- ----------------------------------------------------------------
-- 5. RLS — read-only for members; ALL writes go through the RPCs
-- ----------------------------------------------------------------
alter table public.photo_upload_intents enable row level security;

create policy "members read company photo upload intents"
  on public.photo_upload_intents
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- Deliberately NO insert / update / delete policies.

grant select on public.photo_upload_intents to authenticated;


-- ----------------------------------------------------------------
-- 6. CLOSE THE DIRECT-SUBMIT BYPASS
-- ----------------------------------------------------------------
-- Migration 20260602120000 granted table-wide UPDATE on evidence_packs to
-- `authenticated`, so any member (an old deployment, a stale tab, a preview
-- URL, or a hand-crafted PostgREST call) could set status = 'submitted'
-- directly and skip every check.
--
-- MECHANISM: column-level privileges. Table-wide UPDATE is revoked and
-- re-granted ONLY on the columns a client may legitimately change. status,
-- submitted_at and submitted_by are no longer client-writable at all, so the
-- transition is impossible outside a SECURITY DEFINER function (which runs as
-- the owner and is not subject to these grants). This is a hard database
-- guarantee — it does not depend on a session flag the client could set.
--
-- The RLS policies are unchanged: membership is still required, and this only
-- narrows what an authorised member may write.
--
-- NOTE ON OTHER PACK TYPES: this applies to every pack type, so a future pack
-- type will need its own finalise RPC (v1 only ships 'pre_arrival'). The
-- application surfaces this as a clear error rather than a silent failure.
revoke update on public.evidence_packs from authenticated;
grant update (title, notes, deleted_at) on public.evidence_packs to authenticated;

-- INSERT was ALSO table-wide, so a client could create a pack that is BORN
-- 'submitted' (skipping every check). Column-level INSERT fixes that: status,
-- submitted_at and submitted_by cannot be supplied at all, so they take their
-- defaults ('draft', null, null).
revoke insert on public.evidence_packs from authenticated;
grant insert (company_id, property_id, pack_type, title, notes, started_by, started_at)
  on public.evidence_packs to authenticated;
-- select is unchanged.


-- ----------------------------------------------------------------
-- 6b. CLOSE RAW PACK-PHOTO WRITES + MAKE SUBMITTED EVIDENCE IMMUTABLE
-- ----------------------------------------------------------------
-- Migration 20260601120000 granted table-wide INSERT/UPDATE on public.photos.
-- That let an authenticated client link a photo straight to a pack, RELINK an
-- existing photo, or soft-delete evidence — all without the pack lock, which
-- could race the bidirectional finalise check.
--
-- MECHANISM (a): column-level privileges. `evidence_pack_id` becomes
-- non-writable by clients, so a pre-arrival pack link can ONLY be created by
-- the SECURITY DEFINER attach/recover RPCs (owner-run, exempt from grants).
-- UPDATE narrows to the two columns the app legitimately changes.
-- FLAG photos are unaffected: they never set evidence_pack_id.
revoke insert, update on public.photos from authenticated;
grant insert (
  id, company_id, property_id, stay_id, inspection_id, inspection_item_id,
  flag_id, issue_id, maintenance_job_id, inventory_movement_id,
  guest_recovery_task_id, entity_type, retention_class, uploaded_by,
  captured_at, uploaded_at, storage_path, thumbnail_path, file_hash,
  mime_type, width, height, size_bytes, notes, sync_status
) on public.photos to authenticated;
grant update (notes, deleted_at) on public.photos to authenticated;

-- MECHANISM (b): a trigger, because immutability-after-submit cannot be
-- expressed with grants. Applies ONLY to rows linked to a pre-arrival pack,
-- so flag photos and unlinked photos behave exactly as before.
create or replace function public.photos_prearrival_pack_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
  v_type   text;
begin
  if tg_op = 'INSERT' then
    if new.evidence_pack_id is null then
      return new;
    end if;
    select ep.status, ep.pack_type into v_status, v_type
    from public.evidence_packs ep where ep.id = new.evidence_pack_id;
    if v_type = 'pre_arrival' and v_status is distinct from 'draft' then
      raise exception 'cannot add photos to a pack that is not a draft'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE / DELETE
  if old.evidence_pack_id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select ep.status, ep.pack_type into v_status, v_type
  from public.evidence_packs ep where ep.id = old.evidence_pack_id;

  if v_type is distinct from 'pre_arrival' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Submitted evidence is completely immutable.
  if v_status = 'submitted' then
    raise exception 'submitted pre-arrival evidence is immutable'
      using errcode = '42501';
  end if;

  -- A pre-arrival pack photo may NEVER be hard-deleted directly: that would
  -- leave its completed intent without an active photo and permanently block
  -- finalisation (the reverse invariant could never be satisfied again).
  if tg_op = 'DELETE' then
    raise exception 'pre-arrival pack photos cannot be deleted directly'
      using errcode = '42501';
  end if;

  -- Same reasoning for SOFT-delete on a DRAFT pack. Removing an individual
  -- photo will get its own audited RPC (which will also resolve the intent);
  -- until then this is prohibited rather than allowed to strand a pack.
  if new.deleted_at is distinct from old.deleted_at then
    raise exception
      'pre-arrival pack photos cannot be removed directly — discard the pack instead'
      using errcode = '42501';
  end if;

  if new.evidence_pack_id is distinct from old.evidence_pack_id then
    raise exception 'pre-arrival pack photos cannot be relinked'
      using errcode = '42501';
  end if;

  return new;
end;
$$;


-- ----------------------------------------------------------------
-- 6c. SUBMITTED PACKS ARE IMMUTABLE
-- ----------------------------------------------------------------
-- Clients still hold column-level UPDATE on (title, notes, deleted_at), which
-- would let a SUBMITTED pack be edited or soft-deleted after the fact. A
-- submitted pre-arrival pack is a finished record: nothing about it may change
-- and it may not be deleted.
--
-- The legitimate finalise transition is unaffected because it runs while the
-- row is still 'draft' (OLD.status = 'draft'). Duplicate finalisation stays
-- idempotent because finalize_prearrival_pack() returns 'already_submitted'
-- BEFORE issuing any UPDATE, so this trigger never fires for it.
create or replace function public.evidence_packs_submitted_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.pack_type is distinct from 'pre_arrival' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if old.status = 'submitted' then
    raise exception 'a submitted pre-arrival pack is immutable'
      using errcode = '42501';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger trg_evidence_packs_submitted_immutable
  before update or delete on public.evidence_packs
  for each row execute function public.evidence_packs_submitted_immutable();

create trigger trg_photos_prearrival_pack_guard
  before insert or update or delete on public.photos
  for each row execute function public.photos_prearrival_pack_guard();


-- ----------------------------------------------------------------
-- 7. Shared guard: resolve + authorise a draft pre-arrival pack
-- ----------------------------------------------------------------
create or replace function public.assert_draft_prearrival_pack(p_pack_id uuid)
returns table (company_id uuid, property_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company  uuid;
  v_property uuid;
  v_type     text;
  v_status   text;
  v_prop_co  uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select ep.company_id, ep.property_id, ep.pack_type, ep.status
    into v_company, v_property, v_type, v_status
  from public.evidence_packs ep
  where ep.id = p_pack_id and ep.deleted_at is null;

  if v_company is null then
    raise exception 'evidence pack % not found', p_pack_id using errcode = 'P0002';
  end if;
  if v_type <> 'pre_arrival' then
    raise exception 'pack % is not a pre-arrival pack', p_pack_id using errcode = '22023';
  end if;
  if v_status <> 'draft' then
    raise exception 'pack % is not a draft', p_pack_id using errcode = '22023';
  end if;

  select p.company_id into v_prop_co
  from public.properties p
  where p.id = v_property and p.deleted_at is null;

  if v_prop_co is null or v_prop_co is distinct from v_company then
    raise exception 'pack % property scope mismatch', p_pack_id using errcode = '23514';
  end if;

  if not public.is_company_member(v_company) then
    raise exception 'not a member of the owning company' using errcode = '42501';
  end if;

  company_id := v_company;
  property_id := v_property;
  return next;
end;
$$;


-- ----------------------------------------------------------------
-- 8. create_prearrival_photo_intent — idempotent slot issuance
-- ----------------------------------------------------------------
-- Called BEFORE any signed upload URL is issued. The client supplies (and
-- REUSES on every retry) the logical photo id, so a failure between intent
-- creation and URL delivery is safely recoverable: the same uuid returns the
-- same relationship and paths. Identity conflicts fail closed.
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
-- 9. attach_prearrival_photo — atomic intent -> photos row
-- ----------------------------------------------------------------
-- Lock order: evidence_packs (SHARE) then photo_upload_intents (UPDATE).
-- The SHARE lock lets concurrent attaches proceed but makes them mutually
-- exclusive with finalise, so a photo can never land mid-finalise.
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

  v_note := left(nullif(btrim(coalesce(p_note, '')), ''), 2000);

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
-- 10. discard_prearrival_photo_intent — explicit, audited abandon
-- ----------------------------------------------------------------
-- The ONLY sanctioned way to abandon a promised photo. A reason is REQUIRED
-- (enforced here and by the table constraint). Completed photos can never be
-- discarded this way, and no Storage evidence is deleted.
-- Lock order: evidence_packs (SHARE) then photo_upload_intents (UPDATE).
create or replace function public.discard_prearrival_photo_intent(
  p_photo_id uuid,
  p_reason   text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack   uuid;
  v_intent public.photo_upload_intents%rowtype;
  v_reason text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_reason := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  if v_reason is null then
    raise exception 'a discard reason is required' using errcode = '22023';
  end if;

  select evidence_pack_id into v_pack
  from public.photo_upload_intents where id = p_photo_id;
  if v_pack is null then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;

  perform 1 from public.evidence_packs where id = v_pack for share;
  perform 1 from public.assert_draft_prearrival_pack(v_pack);

  select * into v_intent from public.photo_upload_intents
  where id = p_photo_id
  for update;
  if not found then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;

  if v_intent.state = 'discarded' then
    return 'already_discarded';
  end if;
  if v_intent.state = 'completed' then
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


-- ----------------------------------------------------------------
-- 10b. recover_prearrival_photo_intent — rescue already-uploaded bytes
-- ----------------------------------------------------------------
-- If the objects reached Storage but the attach response was lost (or the tab
-- was closed / device reloaded), the evidence EXISTS and must not be thrown
-- away. This completes the intent from Storage alone — no device file needed,
-- so the inspector never has to revisit a property whose photos are already
-- stored. Everything is derived from the intent + storage.objects; the caller
-- supplies nothing. size_bytes comes from the object metadata; width/height
-- are left null (they are nullable and cosmetic) rather than guessed.
-- Lock order: evidence_packs (SHARE) then photo_upload_intents (UPDATE).
create or replace function public.recover_prearrival_photo_intent(p_photo_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack   uuid;
  v_intent public.photo_upload_intents%rowtype;
  v_photo  public.photos%rowtype;
  v_size   int;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select evidence_pack_id into v_pack
  from public.photo_upload_intents where id = p_photo_id;
  if v_pack is null then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;

  perform 1 from public.evidence_packs where id = v_pack for share;
  perform 1 from public.assert_draft_prearrival_pack(v_pack);

  select * into v_intent from public.photo_upload_intents
  where id = p_photo_id
  for update;
  if not found then
    raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
  end if;
  if v_intent.state = 'discarded' then
    raise exception 'photo intent % was discarded', p_photo_id using errcode = '22023';
  end if;

  -- The bytes MUST already be in Storage — that is the whole point.
  -- Size parsing is DEFENSIVE: storage metadata is not guaranteed to exist or
  -- to be well-formed. A missing/NULL/non-numeric/oversized value yields NULL
  -- (size_bytes is nullable and cosmetic) rather than raising — so a odd
  -- metadata row can never abort recovery and strand the pending intent.
  -- Existence is decided by FOUND, never by the parsed size.
  select case
           when o.metadata is not null
            and (o.metadata->>'size') ~ '^[0-9]{1,18}$'
           then least((o.metadata->>'size')::bigint, 2147483647)::int
           else null
         end
    into v_size
  from storage.objects o
  where o.bucket_id = 'evidence-photos' and o.name = v_intent.master_path;
  if not found then
    raise exception
      'the original image for this photo is not in storage — it must be recaptured'
      using errcode = '23514';
  end if;
  if v_intent.thumb_path is not null then
    perform 1 from storage.objects
     where bucket_id = 'evidence-photos' and name = v_intent.thumb_path;
    if not found then
      raise exception
        'the thumbnail for this photo is not in storage — it must be recaptured'
        using errcode = '23514';
    end if;
  end if;

  select * into v_photo from public.photos where id = p_photo_id;
  if found then
    if v_photo.deleted_at is not null then
      raise exception 'photo % was deleted; cannot recover', p_photo_id
        using errcode = '23505';
    end if;
    if v_photo.company_id       is distinct from v_intent.company_id
       or v_photo.property_id      is distinct from v_intent.property_id
       or v_photo.evidence_pack_id is distinct from v_intent.evidence_pack_id
       or v_photo.storage_path     is distinct from v_intent.master_path then
      raise exception 'photo % already exists with different data', p_photo_id
        using errcode = '23505';
    end if;
  else
    insert into public.photos (
      id, company_id, property_id, evidence_pack_id, entity_type,
      retention_class, uploaded_by, storage_path, thumbnail_path,
      mime_type, size_bytes, sync_status
    ) values (
      p_photo_id, v_intent.company_id, v_intent.property_id,
      v_intent.evidence_pack_id, 'property',
      'routine_pre_arrival', v_intent.created_by,
      v_intent.master_path, v_intent.thumb_path,
      'image/jpeg', v_size, 'synced'
    );
  end if;

  if v_intent.state = 'completed' then
    return 'already_completed';
  end if;

  update public.photo_upload_intents
     set state = 'completed', completed_at = now()
   where id = p_photo_id;

  return 'recovered';
end;
$$;


-- ----------------------------------------------------------------
-- 11. finalize_prearrival_pack — atomic, authoritative, BIDIRECTIONAL
-- ----------------------------------------------------------------
-- Takes the EXCLUSIVE pack lock (lock order step 1), so no attach or discard
-- can interleave. No client-supplied count is accepted or trusted.
create or replace function public.finalize_prearrival_pack(p_pack_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company    uuid;
  v_property   uuid;
  v_status     text;
  v_type       text;
  v_prop_co    uuid;
  v_unresolved int;
  v_active     int;
  v_bad        int;
  v_orphans    int;
  v_rec        record;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- (1) EXCLUSIVE lock on the pack for the whole transaction.
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

  -- (a) No unresolved (still pending) intents.
  select count(*) into v_unresolved
  from public.photo_upload_intents
  where evidence_pack_id = p_pack_id and state = 'pending';
  if v_unresolved > 0 then
    raise exception
      '% photo upload(s) are still unresolved — retry them, or discard them with a reason',
      v_unresolved using errcode = '23514';
  end if;

  -- (b) FORWARD: every completed intent has its exact active photo + objects.
  v_bad := 0;
  for v_rec in
    select i.id, i.master_path, i.thumb_path, i.company_id, i.property_id
    from public.photo_upload_intents i
    where i.evidence_pack_id = p_pack_id and i.state = 'completed'
  loop
    perform 1 from public.photos ph
     where ph.id = v_rec.id
       and ph.deleted_at is null
       and ph.evidence_pack_id = p_pack_id
       and ph.company_id = v_rec.company_id
       and ph.property_id = v_rec.property_id
       and ph.storage_path = v_rec.master_path
       and ph.thumbnail_path is not distinct from v_rec.thumb_path;
    if not found then v_bad := v_bad + 1; continue; end if;

    perform 1 from storage.objects
     where bucket_id = 'evidence-photos' and name = v_rec.master_path;
    if not found then v_bad := v_bad + 1; continue; end if;

    if v_rec.thumb_path is not null then
      perform 1 from storage.objects
       where bucket_id = 'evidence-photos' and name = v_rec.thumb_path;
      if not found then v_bad := v_bad + 1; continue; end if;
    end if;
  end loop;
  if v_bad > 0 then
    raise exception
      '% saved photo(s) could not be verified against storage — recapture before submitting',
      v_bad using errcode = '23514';
  end if;

  -- (c) REVERSE: every active photo on this pack has a completed intent.
  --     This is what blocks a photo written by a legacy/bypass path after
  --     this migration (it would have no intent).
  select count(*) into v_orphans
  from public.photos ph
  where ph.evidence_pack_id = p_pack_id
    and ph.deleted_at is null
    and not exists (
      select 1 from public.photo_upload_intents i
      where i.id = ph.id
        and i.evidence_pack_id = p_pack_id
        and i.state = 'completed'
    );
  if v_orphans > 0 then
    raise exception
      '% photo(s) on this pack were not recorded through the verified upload path — they cannot be submitted',
      v_orphans using errcode = '23514';
  end if;

  -- (d) At least one active linked photo.
  select count(*) into v_active
  from public.photos
  where evidence_pack_id = p_pack_id and deleted_at is null;
  if v_active < 1 then
    raise exception 'pack % has no saved photos', p_pack_id using errcode = '23514';
  end if;

  -- Idempotent replay of a lost response: already submitted AND still valid
  -- (every check above has just passed for this same pack).
  if v_status = 'submitted' then
    return 'already_submitted';
  end if;
  if v_status <> 'draft' then
    raise exception 'pack % is in an unexpected state (%)', p_pack_id, v_status
      using errcode = '22023';
  end if;

  update public.evidence_packs
     set status = 'submitted', submitted_at = now(), submitted_by = auth.uid()
   where id = p_pack_id and status = 'draft';

  return 'submitted';
end;
$$;


-- ----------------------------------------------------------------
-- 12. Execute grants (authorisation happens INSIDE each function)
-- ----------------------------------------------------------------
revoke all on function public.assert_draft_prearrival_pack(uuid) from public;
revoke all on function public.create_prearrival_photo_intent(uuid, uuid) from public;
revoke all on function public.attach_prearrival_photo(uuid, int, int, int, timestamptz, text) from public;
revoke all on function public.discard_prearrival_photo_intent(uuid, text) from public;
revoke all on function public.recover_prearrival_photo_intent(uuid) from public;
revoke all on function public.finalize_prearrival_pack(uuid) from public;

grant execute on function public.create_prearrival_photo_intent(uuid, uuid) to authenticated;
grant execute on function public.attach_prearrival_photo(uuid, int, int, int, timestamptz, text) to authenticated;
grant execute on function public.discard_prearrival_photo_intent(uuid, text) to authenticated;
grant execute on function public.recover_prearrival_photo_intent(uuid) to authenticated;
grant execute on function public.finalize_prearrival_pack(uuid) to authenticated;
-- assert_draft_prearrival_pack is internal: no direct grant.


-- ----------------------------------------------------------------
-- 13. Backfill BEFORE enforcement (metadata only, DRAFT packs only)
-- ----------------------------------------------------------------
-- The reverse invariant (11c) would otherwise reject every in-flight draft
-- created before this migration, so EVERY active photo on a draft pre-arrival
-- pack gets a matching 'completed' intent here. Runs in the same transaction
-- as the function definitions, so enforcement never observes unbackfilled data.
--
-- thumb_path mirrors the photo row exactly (NULL where the legacy row has no
-- thumbnail), which is why thumb_path is nullable. No Storage is touched.
--
-- Submitted / historical packs are deliberately NOT backfilled and not
-- altered: they are immutable records, and finalise never runs against them.
insert into public.photo_upload_intents (
  id, company_id, property_id, evidence_pack_id,
  master_path, thumb_path, state, created_by, created_at, completed_at
)
select
  ph.id, ph.company_id, ph.property_id, ph.evidence_pack_id,
  ph.storage_path, ph.thumbnail_path, 'completed', ph.uploaded_by,
  ph.uploaded_at, ph.uploaded_at
from public.photos ph
join public.evidence_packs ep on ep.id = ph.evidence_pack_id
where ph.deleted_at is null
  and ph.evidence_pack_id is not null
  and ph.property_id is not null
  and ep.deleted_at is null
  and ep.status = 'draft'
  and ep.pack_type = 'pre_arrival'
on conflict (id) do nothing;
