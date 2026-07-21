-- ============================================================
-- Cancellation-tombstone + lock-order tests (chat directives A–H + I–L)
-- ============================================================
-- Plain SQL for:  pnpm.cmd exec supabase db query --linked -f supabase/tests/prearrival_cancellation_test.sql
--
-- SELF-CONTAINED and SIDE-EFFECT-FREE: applies migration
-- 20260721090000_prearrival_photo_cancellation.sql INSIDE this transaction,
-- runs every ordering, prints a verdict, then ROLLS BACK. The database is
-- unchanged afterwards whether it passes or fails.
--
-- These are the actual network orderings, expressed as commit orderings — in
-- one session, "the discard commits before the delayed slot request arrives"
-- is exactly "call discard, then call the slot RPC". Row/pack locking (PK +
-- FOR SHARE/FOR UPDATE) serialises true concurrent interleavings onto one of
-- these orderings, which is the invariant's whole design.
begin;

-- ---- apply the migration under test (rolled back at the end) ----
-- Keep in sync with supabase/migrations/20260721090000_prearrival_photo_cancellation.sql

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

  perform 1 from public.evidence_packs where id = p_pack_id for share;

  select a.company_id, a.property_id into v_company, v_property
  from public.assert_draft_prearrival_pack(p_pack_id) a;

  v_master := format('companies/%s/property/%s/%s.jpg', v_company, v_property, p_photo_id);
  v_thumb  := format('companies/%s/property/%s/%s_thumb.jpg', v_company, v_property, p_photo_id);

  select * into v_existing from public.photo_upload_intents where id = p_photo_id;
  if found then
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

  if v_pack is not null and p_pack_id is not null
     and v_pack is distinct from p_pack_id then
    raise exception 'photo % belongs to a different pack', p_photo_id
      using errcode = '23505';
  end if;

  if v_pack is null then
    if p_pack_id is null then
      raise exception 'no upload intent for photo %', p_photo_id using errcode = 'P0002';
    end if;

    perform 1 from public.evidence_packs where id = p_pack_id for share;
    select a.company_id, a.property_id into v_company, v_property
    from public.assert_draft_prearrival_pack(p_pack_id) a;

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

revoke all on function public.discard_prearrival_photo_intent(uuid, text, uuid)
  from public;
grant execute on function public.discard_prearrival_photo_intent(uuid, text, uuid)
  to authenticated;

-- ---- test harness ----

create temporary table _chk (n serial, label text, pass boolean) on commit drop;

create or replace function pg_temp.chk(p_label text, p_pass boolean)
returns void language sql as $$ insert into _chk (label, pass) values (p_label, p_pass) $$;

create or replace function pg_temp.must_fail(p_label text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_label || '  (NOT REJECTED)', false);
  exception when others then
    perform pg_temp.chk(p_label || '  [' || sqlstate || ']', true);
  end;
end $$;

do $$
declare
  v_user uuid; v_company uuid := '1669c464-8d26-40fc-9956-9f8955fd27c7';
  v_property uuid; v_property2 uuid; v_pack uuid; v_pack2 uuid; v_pack3 uuid;
  pid_a uuid := gen_random_uuid();  -- A/F/G: tombstone first
  pid_b uuid := gen_random_uuid();  -- B/C/D/E: intent first
  pid_h uuid := gen_random_uuid();  -- H: unrelated bystander
  pid_i uuid := gen_random_uuid();  -- I: delayed slot vs finalisation
  pid_j uuid := gen_random_uuid();  -- J: attach-first vs discard
  pid_k uuid := gen_random_uuid();  -- K: identity / pack mismatch
  v_res text; v_state text; v_n int;
begin
  -- fixtures: test company, an active member, two properties with no active draft
  if not exists (select 1 from public.companies where id = v_company) then
    raise exception 'ABORTED: test company not found';
  end if;
  select cm.user_id into v_user from public.company_memberships cm
  where cm.company_id = v_company and cm.is_active and cm.deleted_at is null
  limit 1;
  select p.id into v_property from public.properties p
  where p.company_id = v_company and p.deleted_at is null
    and not exists (select 1 from public.evidence_packs ep
      where ep.property_id = p.id and ep.pack_type = 'pre_arrival'
        and ep.status = 'draft' and ep.deleted_at is null)
  order by p.name limit 1;
  select p.id into v_property2 from public.properties p
  where p.company_id = v_company and p.deleted_at is null and p.id <> v_property
    and not exists (select 1 from public.evidence_packs ep
      where ep.property_id = p.id and ep.pack_type = 'pre_arrival'
        and ep.status = 'draft' and ep.deleted_at is null)
  order by p.name limit 1;
  if v_user is null or v_property is null or v_property2 is null then
    raise exception 'ABORTED: fixtures missing (member / two free properties)';
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property, 'pre_arrival', 'draft', 'CANCEL-TEST-ROLLBACK', v_user)
  returning id into v_pack;

  -- ---------- A: discard commits BEFORE the delayed slot request ----------
  v_res := public.discard_prearrival_photo_intent(pid_a, 'removed before any upload', v_pack);
  perform pg_temp.chk('A1: preemptive discard succeeds with no intent (' || v_res || ')',
                      v_res in ('discarded', 'already_discarded'));
  select state into v_state from public.photo_upload_intents where id = pid_a;
  perform pg_temp.chk('A2: durable tombstone exists in state=discarded', v_state = 'discarded');
  perform pg_temp.chk('A3: tombstone carries full audit (at/by/reason)',
    (select discarded_at is not null and discarded_by is not null
        and length(discard_reason) > 0
     from public.photo_upload_intents where id = pid_a));
  perform pg_temp.must_fail('A4: delayed slot request REJECTED by tombstone',
    format('select * from public.create_prearrival_photo_intent(%L, %L)', v_pack, pid_a));

  -- ---------- B: slot exists before discard ----------
  perform public.create_prearrival_photo_intent(v_pack, pid_b);
  select state into v_state from public.photo_upload_intents where id = pid_b;
  perform pg_temp.chk('B1: intent created pending', v_state = 'pending');
  v_res := public.discard_prearrival_photo_intent(pid_b, 'removed after slot', v_pack);
  perform pg_temp.chk('B2: discard of existing intent (' || v_res || ')', v_res = 'discarded');

  -- ---------- C/D: attach arrives after discard committed ----------
  perform pg_temp.must_fail('C/D: attach of discarded photo REJECTED',
    format('select public.attach_prearrival_photo(%L, 100, 100, 1000, now(), null)', pid_b));

  -- ---------- E: repeated discard is idempotent ----------
  v_res := public.discard_prearrival_photo_intent(pid_b, 'second removal', v_pack);
  perform pg_temp.chk('E1: repeat discard idempotent (' || v_res || ')', v_res = 'already_discarded');
  v_res := public.discard_prearrival_photo_intent(pid_a, 'second removal of tombstone', v_pack);
  perform pg_temp.chk('E2: repeat tombstone discard idempotent (' || v_res || ')',
                      v_res = 'already_discarded');

  -- ---------- F: retry from an old tab after discard ----------
  perform pg_temp.must_fail('F1: old-tab slot replay for discarded id REJECTED',
    format('select * from public.create_prearrival_photo_intent(%L, %L)', v_pack, pid_b));
  perform pg_temp.must_fail('F2: old-tab slot replay for tombstoned id REJECTED',
    format('select * from public.create_prearrival_photo_intent(%L, %L)', v_pack, pid_a));

  -- ---------- G: a cancelled photo can never become attached ----------
  perform pg_temp.must_fail('G1: attach of never-uploaded tombstoned photo REJECTED',
    format('select public.attach_prearrival_photo(%L, 100, 100, 1000, now(), null)', pid_a));
  select count(*) into v_n from public.photos where id in (pid_a, pid_b);
  perform pg_temp.chk('G2: no photos row exists for any cancelled id', v_n = 0);

  -- ---------- I: delayed slot request vs pack finalisation ----------
  -- The lock fix makes the interleaving serialise; the committed-state
  -- outcome we can assert single-session is: once the pack is submitted, a
  -- late slot request and a late tombstone are both rejected.
  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property2, 'pre_arrival', 'draft', 'CANCEL-TEST-I-ROLLBACK', v_user)
  returning id into v_pack2;
  -- (superuser session may bypass client grant revocations; this models the
  -- pack having been finalised)
  update public.evidence_packs
     set status = 'submitted', submitted_at = now(), submitted_by = v_user
   where id = v_pack2;
  perform pg_temp.must_fail('I1: slot request into a SUBMITTED pack REJECTED',
    format('select * from public.create_prearrival_photo_intent(%L, %L)', v_pack2, pid_i));
  perform pg_temp.must_fail('I2: tombstone into a SUBMITTED pack REJECTED',
    format('select public.discard_prearrival_photo_intent(%L, %L, %L)',
           pid_i, 'late removal', v_pack2));
  perform pg_temp.chk('I3: no intent row leaked into the submitted pack',
    not exists (select 1 from public.photo_upload_intents where id = pid_i));

  -- ---------- J: ATTACH-FIRST vs discard (the other legal ordering) ----------
  perform public.create_prearrival_photo_intent(v_pack, pid_j);
  -- Model a completed attach (storage-verified path already covered by the
  -- 20260718 suite): completed intent + matching photos row.
  update public.photo_upload_intents
     set state = 'completed', completed_at = now()
   where id = pid_j;
  insert into public.photos (
    id, company_id, property_id, evidence_pack_id, entity_type, retention_class,
    uploaded_by, captured_at, storage_path, thumbnail_path, mime_type,
    width, height, size_bytes, sync_status
  )
  select i.id, i.company_id, i.property_id, i.evidence_pack_id, 'property',
         'routine_pre_arrival', v_user, now(), i.master_path, i.thumb_path,
         'image/jpeg', 100, 100, 1000, 'synced'
  from public.photo_upload_intents i where i.id = pid_j;
  perform pg_temp.must_fail('J1: discard AFTER attach fails terminally (already saved)',
    format('select public.discard_prearrival_photo_intent(%L, %L, %L)',
           pid_j, 'removed too late', v_pack));
  select state into v_state from public.photo_upload_intents where id = pid_j;
  perform pg_temp.chk('J2: attach outcome preserved (state=completed)', v_state = 'completed');
  perform pg_temp.chk('J3: attached photo row survives the failed discard',
    exists (select 1 from public.photos where id = pid_j and deleted_at is null));

  -- ---------- K: identity / pack mismatch fails closed ----------
  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property2, 'pre_arrival', 'draft', 'CANCEL-TEST-K-ROLLBACK', v_user)
  returning id into v_pack3;
  perform public.create_prearrival_photo_intent(v_pack, pid_k);
  perform pg_temp.must_fail('K1: discard with the WRONG pack id REJECTED (no cross-discard)',
    format('select public.discard_prearrival_photo_intent(%L, %L, %L)',
           pid_k, 'confused client', v_pack3));
  select state into v_state from public.photo_upload_intents where id = pid_k;
  perform pg_temp.chk('K2: mismatched discard changed nothing (still pending)',
                      v_state = 'pending');

  -- ---------- H: unrelated photos continue processing ----------
  perform public.create_prearrival_photo_intent(v_pack, pid_h);
  select state into v_state from public.photo_upload_intents where id = pid_h;
  perform pg_temp.chk('H1: bystander intent still pending after all cancellations',
                      v_state = 'pending');
  perform public.create_prearrival_photo_intent(v_pack, pid_h);
  perform pg_temp.chk('H2: bystander slot replay still succeeds', true);
end $$;

-- ---------- L: PUBLIC / anon cannot execute the new discard function ----------
do $$
begin
  begin
    execute 'set local role anon';
    begin
      perform public.discard_prearrival_photo_intent(gen_random_uuid(), 'x', null);
      execute 'reset role';
      perform pg_temp.chk('L1: anon execute REJECTED  (NOT REJECTED)', false);
    exception when others then
      execute 'reset role';
      -- insufficient_privilege (42501) is the expected shape
      perform pg_temp.chk('L1: anon execute REJECTED  [' || sqlstate || ']',
                          sqlstate = '42501');
    end;
  exception when others then
    -- role anon absent on this database: record explicitly rather than pass
    perform pg_temp.chk('L1: SKIPPED — role anon not settable here', false);
  end;
end $$;

-- ---- verdict (the ONLY result set: supabase db query shows the last one) ----
select
  case when count(*) filter (where not pass) = 0
       then 'CANCELLATION TESTS: ALL ' || count(*) || ' PASS (rolled back)'
       else 'CANCELLATION TESTS: ' || count(*) filter (where not pass) || ' FAILED of ' || count(*)
  end as verdict,
  string_agg(case when not pass then label end, ' | ') as failures
from _chk;

rollback;
