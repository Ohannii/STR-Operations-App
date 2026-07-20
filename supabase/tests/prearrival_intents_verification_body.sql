-- ============================================================
-- Pre-arrival photo intents — verification BODY (no transaction control)
-- ============================================================
-- Included by:
--   * prearrival_intents_verification.sql  (begin; \ir body; rollback;)
--   * prearrival_rehearsal.sql             (begin; \ir migration; \ir body; rollback;)
--
-- Contains NO begin/commit/rollback so it can compose. Writes only throwaway
-- rows scoped to the Drop-Inn `test` company / property "Test 1", which the
-- caller always rolls back. Never writes auth.users. Never touches Unit 407.
-- ============================================================

create or replace function pg_temp.chk(p_label text, p_ok boolean)
returns void language plpgsql as $$
begin
  raise notice '%  %', case when p_ok then 'PASS' else 'FAIL --->' end, p_label;
end $$;

-- Run SQL that MUST be rejected. PASS when it raises.
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

-- Same, executed as the `authenticated` role with a real JWT claim.
create or replace function pg_temp.must_fail_as_user(p_label text, p_sql text, p_user uuid)
returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    execute 'reset role';
    perform pg_temp.chk(p_label || '  (NOT REJECTED)', false);
  exception when others then
    execute 'reset role';
    perform pg_temp.chk(p_label || '  [' || sqlstate || ']', true);
  end;
end $$;

-- Run SQL as the user that MUST SUCCEED.
create or replace function pg_temp.must_pass_as_user(p_label text, p_sql text, p_user uuid)
returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    execute 'reset role';
    perform pg_temp.chk(p_label, true);
  exception when others then
    execute 'reset role';
    perform pg_temp.chk(p_label || '  (REJECTED: ' || sqlerrm || ')', false);
  end;
end $$;

-- Resolve fixtures ONCE, failing hard if the expected environment is absent.
create or replace function pg_temp.fixtures(out o_user uuid, out o_company uuid, out o_property uuid)
language plpgsql as $$
begin
  o_company := '1669c464-8d26-40fc-9956-9f8955fd27c7';

  if not exists (select 1 from public.companies where id = o_company) then
    raise exception 'VERIFICATION ABORTED: test company % not found on this database', o_company;
  end if;

  select id into o_property from public.properties
  where company_id = o_company and deleted_at is null and name = 'Test 1'
  limit 1;
  if o_property is null then
    raise exception 'VERIFICATION ABORTED: property "Test 1" not found in the test company';
  end if;

  select cm.user_id into o_user from public.company_memberships cm
  where cm.company_id = o_company and cm.is_active and cm.deleted_at is null
  limit 1;
  if o_user is null then
    raise exception 'VERIFICATION ABORTED: no active member in the test company';
  end if;
end $$;


do $$
declare
  v_user uuid; v_company uuid; v_property uuid;
  v_pack uuid; v_pack2 uuid;
  v_pid uuid := gen_random_uuid();
  v_pid2 uuid := gen_random_uuid();
  v_pid3 uuid := gen_random_uuid();
  v_master text; v_thumb text; v_res text; v_n int;
begin
  select o_user, o_company, o_property into v_user, v_company, v_property
  from pg_temp.fixtures();
  raise notice 'fixtures: user=% company=% property(Test 1)=%', v_user, v_company, v_property;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property, 'pre_arrival', 'draft', 'VERIFY-ROLLBACK', v_user)
  returning id into v_pack;

  -- 01 empty pack cannot finalise
  perform pg_temp.must_fail('01 empty pack blocked',
    format('select public.finalize_prearrival_pack(%L)', v_pack));

  -- 02 pending intent blocks finalise
  select master_path, thumb_path into v_master, v_thumb
  from public.create_prearrival_photo_intent(v_pack, v_pid);
  perform pg_temp.chk('02 intent created pending',
    (select state from public.photo_upload_intents where id = v_pid) = 'pending');
  perform pg_temp.must_fail('02 pending intent blocks finalise',
    format('select public.finalize_prearrival_pack(%L)', v_pack));

  -- 03 idempotent slot re-issue (lost URL/response)
  perform pg_temp.chk('03 slot re-issue idempotent',
    (select master_path from public.create_prearrival_photo_intent(v_pack, v_pid)) = v_master);

  -- 04 attach without objects fails closed
  perform pg_temp.must_fail('04 attach without object blocked',
    format('select public.attach_prearrival_photo(%L,100,100,1000,now(),null)', v_pid));

  -- 05 attach + idempotent replay
  insert into storage.objects (bucket_id, name, metadata)
  values ('evidence-photos', v_master, jsonb_build_object('size', 1234)),
         ('evidence-photos', v_thumb,  jsonb_build_object('size', 99));
  select public.attach_prearrival_photo(v_pid,100,100,1000,now(),null) into v_res;
  perform pg_temp.chk('05 attach completes', v_res = 'completed');
  select public.attach_prearrival_photo(v_pid,100,100,1000,now(),null) into v_res;
  perform pg_temp.chk('05 duplicate attach idempotent', v_res = 'already_completed');
  select count(*) into v_n from public.photos where id = v_pid;
  perform pg_temp.chk('05 exactly one photo row', v_n = 1);

  -- 06 lost-response recovery from storage alone
  select master_path, thumb_path into v_master, v_thumb
  from public.create_prearrival_photo_intent(v_pack, v_pid2);
  insert into storage.objects (bucket_id, name, metadata)
  values ('evidence-photos', v_master, jsonb_build_object('size', 4321)),
         ('evidence-photos', v_thumb,  jsonb_build_object('size', 88));
  select public.recover_prearrival_photo_intent(v_pid2) into v_res;
  perform pg_temp.chk('06 recovery completes from storage', v_res = 'recovered');
  perform pg_temp.chk('06 size parsed from metadata',
    (select size_bytes from public.photos where id = v_pid2) = 4321);
  select public.recover_prearrival_photo_intent(v_pid2) into v_res;
  perform pg_temp.chk('06 recovery idempotent', v_res = 'already_completed');

  -- 06b malformed metadata must NOT abort recovery or strand the intent
  perform public.create_prearrival_photo_intent(v_pack, v_pid3);
  select master_path, thumb_path into v_master, v_thumb
  from public.photo_upload_intents where id = v_pid3;
  insert into storage.objects (bucket_id, name, metadata)
  values ('evidence-photos', v_master, jsonb_build_object('size', 'not-a-number')),
         ('evidence-photos', v_thumb,  '{}'::jsonb);
  select public.recover_prearrival_photo_intent(v_pid3) into v_res;
  perform pg_temp.chk('06b malformed size recovers with null size',
    v_res = 'recovered'
    and (select size_bytes is null from public.photos where id = v_pid3));

  -- 07 DRAFT pack photos cannot be removed directly
  perform pg_temp.must_fail('07 draft pack photo cannot be soft-deleted',
    format('update public.photos set deleted_at = now() where id = %L', v_pid));
  perform pg_temp.must_fail('07 draft pack photo cannot be deleted',
    format('delete from public.photos where id = %L', v_pid));
  perform pg_temp.must_fail('07 draft pack photo cannot be relinked',
    format('update public.photos set evidence_pack_id = null where id = %L', v_pid));

  -- 08 draft pack title/notes edits still work (as the client role)
  perform pg_temp.must_pass_as_user('08 draft pack title/notes editable',
    format('update public.evidence_packs set title = ''VERIFY-RENAMED'', notes = ''ok'' where id = %L', v_pack),
    v_user);

  -- 09 audited discard of a pending intent still works
  perform public.create_prearrival_photo_intent(v_pack, gen_random_uuid());
  perform pg_temp.must_fail('09 discard without reason blocked',
    format('select public.discard_prearrival_photo_intent(%L, %L)',
           (select id from public.photo_upload_intents
             where evidence_pack_id = v_pack and state = 'pending' limit 1), '   '));
  select public.discard_prearrival_photo_intent(
    (select id from public.photo_upload_intents
      where evidence_pack_id = v_pack and state = 'pending' limit 1),
    'left site, cannot recapture') into v_res;
  perform pg_temp.chk('09 discard with reason works', v_res = 'discarded');
  perform pg_temp.chk('09 discard audited (actor + time + reason)',
    (select count(*) from public.photo_upload_intents
      where evidence_pack_id = v_pack and state = 'discarded'
        and discarded_by = v_user and discarded_at is not null
        and length(discard_reason) > 0) = 1);
  perform pg_temp.must_fail('09 completed intent cannot be discarded',
    format('select public.discard_prearrival_photo_intent(%L, %L)', v_pid, 'nope'));

  -- 10 finalise + duplicate finalise
  select public.finalize_prearrival_pack(v_pack) into v_res;
  perform pg_temp.chk('10 finalise succeeds', v_res = 'submitted');
  select public.finalize_prearrival_pack(v_pack) into v_res;
  perform pg_temp.chk('10 duplicate finalise idempotent', v_res = 'already_submitted');

  -- 11 SUBMITTED pack + evidence are immutable
  perform pg_temp.must_fail('11 submitted pack title cannot change',
    format('update public.evidence_packs set title = ''NOPE'' where id = %L', v_pack));
  perform pg_temp.must_fail('11 submitted pack cannot be soft-deleted',
    format('update public.evidence_packs set deleted_at = now() where id = %L', v_pack));
  perform pg_temp.must_fail('11 submitted pack cannot be deleted',
    format('delete from public.evidence_packs where id = %L', v_pack));
  perform pg_temp.must_fail('11 submitted photo cannot be soft-deleted',
    format('update public.photos set deleted_at = now() where id = %L', v_pid));
  perform pg_temp.must_fail('11 submitted photo cannot be deleted',
    format('delete from public.photos where id = %L', v_pid));
  perform pg_temp.must_fail('11 photo cannot be added to a submitted pack',
    format($q$insert into public.photos
             (id, company_id, property_id, evidence_pack_id, entity_type,
              retention_class, uploaded_by, storage_path, sync_status)
             values (gen_random_uuid(), %L, %L, %L, 'property',
                     'routine_pre_arrival', %L, 'x/y.jpg', 'synced')$q$,
           v_company, v_property, v_pack, v_user));

  -- 12 reverse invariant: an orphan photo blocks finalise
  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property, 'pre_arrival', 'draft', 'VERIFY-ORPHAN', v_user)
  returning id into v_pack2;
  insert into public.photos
    (id, company_id, property_id, evidence_pack_id, entity_type,
     retention_class, uploaded_by, storage_path, sync_status)
  values (gen_random_uuid(), v_company, v_property, v_pack2, 'property',
          'routine_pre_arrival', v_user, 'companies/x/property/y/orphan.jpg', 'synced');
  perform pg_temp.must_fail('12 orphan photo blocks finalise',
    format('select public.finalize_prearrival_pack(%L)', v_pack2));

  -- 13 cross-company / unknown pack rejection
  perform pg_temp.must_fail('13 intent on unknown pack rejected',
    format('select public.create_prearrival_photo_intent(%L, gen_random_uuid())',
           gen_random_uuid()));

  -- 14 backfill consistency for existing draft packs
  select count(*) into v_n
  from public.photos ph
  join public.evidence_packs ep on ep.id = ph.evidence_pack_id
  where ph.deleted_at is null and ep.deleted_at is null
    and ep.company_id = v_company
    and ep.status = 'draft' and ep.pack_type = 'pre_arrival'
    and ep.id <> v_pack2
    and not exists (select 1 from public.photo_upload_intents i
                     where i.id = ph.id and i.state = 'completed');
  perform pg_temp.chk('14 no unbackfilled draft photos (excl. test orphan)', v_n = 0);
end $$;


-- 15 CLIENT-ROLE DENIALS (must run as `authenticated`)
do $$
declare
  v_user uuid; v_company uuid; v_property uuid; v_pack uuid;
begin
  select o_user, o_company, o_property into v_user, v_company, v_property
  from pg_temp.fixtures();

  insert into public.evidence_packs
    (company_id, property_id, pack_type, status, title, started_by)
  values (v_company, v_property, 'pre_arrival', 'draft', 'VERIFY-DENIALS', v_user)
  returning id into v_pack;

  perform pg_temp.must_fail_as_user('15 direct status UPDATE denied',
    format('update public.evidence_packs set status = ''submitted'' where id = %L', v_pack),
    v_user);

  perform pg_temp.must_fail_as_user('15 INSERT with status=submitted denied',
    format($q$insert into public.evidence_packs
             (company_id, property_id, pack_type, status, title, started_by)
             values (%L, %L, 'pre_arrival', 'submitted', 'EVIL', %L)$q$,
           v_company, v_property, v_user),
    v_user);

  perform pg_temp.must_fail_as_user('15 raw pack-photo INSERT denied',
    format($q$insert into public.photos
             (id, company_id, property_id, evidence_pack_id, entity_type,
              retention_class, uploaded_by, storage_path, sync_status)
             values (gen_random_uuid(), %L, %L, %L, 'property',
                     'routine_pre_arrival', %L, 'x/y.jpg', 'synced')$q$,
           v_company, v_property, v_pack, v_user),
    v_user);

  perform pg_temp.must_fail_as_user('15 relink UPDATE denied',
    format('update public.photos set evidence_pack_id = %L where evidence_pack_id is null',
           v_pack),
    v_user);
end $$;

\echo ''
\echo 'RACES (require TWO psql sessions — not simulatable in one transaction):'
\echo '  A) s1: begin; select attach_prearrival_photo(...);   -- hold open'
\echo '     s2: begin; select finalize_prearrival_pack(...);  -- must BLOCK'
\echo '     commit s1 -> s2 proceeds and sees the photo, or fails closed.'
\echo '  B) s1: begin; select finalize_prearrival_pack(...);  -- hold open'
\echo '     s2: select attach_prearrival_photo(...);          -- must BLOCK, then fail'
\echo '         with "pack is not a draft" once s1 commits.'
\echo '  Lock order is always evidence_packs -> photo_upload_intents (no deadlock).'
