-- ============================================================
-- TEST ACTIVITY ISOLATION acceptance tests (migration 20261123120000)
-- ============================================================
-- Runs against a THROWAWAY database that already has every migration
-- applied (including 20261123120000). Wrapped in one transaction that is
-- ROLLED BACK. Never run against the shared staff database without
-- explicit approval. Any failed assertion raises and aborts the run;
-- success prints 'TEST ACTIVITY ISOLATION: ALL PASSED'.
begin;

-- ---------- fixtures (as the migration owner) ----------
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'mgr@a.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'insp@a.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'mgr@b.test');
insert into public.profiles(id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'mgr@a.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'insp@a.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'mgr@b.test')
  on conflict (id) do nothing;
insert into public.companies(id, name) values
  ('0000000c-0000-4000-8000-00000000000a', 'Company A'),
  ('0000000c-0000-4000-8000-00000000000b', 'Company B');
insert into public.company_memberships(company_id, user_id, role_key) values
  ('0000000c-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000a1', 'ops_manager'),
  ('0000000c-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000a2', 'inspector'),
  ('0000000c-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000b1', 'company_admin');
insert into public.properties(id, company_id, name) values
  ('0000000b-0000-4000-8000-000000000013', '0000000c-0000-4000-8000-00000000000a', 'Unit 13'),
  ('0000000b-0000-4000-8000-0000000000f1', '0000000c-0000-4000-8000-00000000000a', 'Test 1'),
  ('0000000b-0000-4000-8000-000000000014', '0000000c-0000-4000-8000-00000000000a', 'Unit 14'),
  ('0000000b-0000-4000-8000-0000000000b9', '0000000c-0000-4000-8000-00000000000b', 'B unit');
-- Asana is switched on for company A only.
insert into public.integration_settings(company_id, provider, is_enabled) values
  ('0000000c-0000-4000-8000-00000000000a', 'asana', true);

create temp table t_ids(k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, service_role;

-- helper: act as a signed-in user
create or replace function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- helper: insert a flag as the current user (mirrors the form path)
create or replace function pg_temp.raise_flag(p_company uuid, p_property uuid, p_is_test boolean default null, p_reason text default null)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  if p_reason = 'forge_handoff' then
    insert into public.flags(id, company_id, property_id, flag_category_id, raised_by, description, asana_handoff_expected)
      values (v, p_company, p_property, (select id from public.flag_categories where key = 'maintenance_issue'), auth.uid(), 't', false);
  elsif p_is_test is null then
    insert into public.flags(id, company_id, property_id, flag_category_id, raised_by, description)
      values (v, p_company, p_property, (select id from public.flag_categories where key = 'maintenance_issue'), auth.uid(), 't');
  else
    insert into public.flags(id, company_id, property_id, flag_category_id, raised_by, description, is_test, test_reason)
      values (v, p_company, p_property, (select id from public.flag_categories where key = 'maintenance_issue'), auth.uid(), 't', p_is_test, p_reason);
  end if;
  return v;
end $$;
grant execute on function pg_temp.raise_flag(uuid, uuid, boolean, text) to authenticated;

-- helper: expect an error with a given SQLSTATE
create or replace function pg_temp.expect_error(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state then raise exception 'FAIL %: expected %, got % (%)', p_label, p_state, sqlstate, sqlerrm; end if;
    return;
  end;
  raise exception 'FAIL %: expected error %, none raised', p_label, p_state;
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated, service_role;

create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin if p_cond is not true then raise exception 'FAIL %', p_label; end if; end $$;
grant execute on function pg_temp.ok(boolean, text) to authenticated, service_role;

-- ---------- 1. normal flag on a real apartment is NOT test ----------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a2');
insert into t_ids values ('normal', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select not is_test and test_reason is null from public.flags where id = (select v from t_ids where k = 'normal')), '1 normal flag not test');
select pg_temp.ok((select asana_handoff_expected from public.flags where id = (select v from t_ids where k = 'normal')), '1b Asana-enabled company: handoff expected');
insert into t_ids values ('forged_handoff', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', null, 'forge_handoff'));
select pg_temp.ok((select asana_handoff_expected from public.flags where id = (select v from t_ids where k = 'forged_handoff')), '1c client cannot opt a new flag out of Asana handoff');
select pg_temp.expect_error($$update public.flags set asana_handoff_expected = false where id = (select v from t_ids where k = 'normal')$$, '42501', '1d handoff marker immutable');

-- ---------- 2. client cannot forge classification either way ----------
insert into t_ids values ('forged', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', true, 'test_session'));
select pg_temp.ok((select not is_test and test_reason is null from public.flags where id = (select v from t_ids where k = 'forged')), '2a client is_test=true ignored');
select pg_temp.expect_error($$update public.flags set is_test = true, test_reason = 'test_session' where id = (select v from t_ids where k = 'normal')$$, '42501', '2b client cannot flip to test');

-- ---------- 3. property test status: roles, validation, audit ----------
select pg_temp.expect_error($$select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', true, 'Training apartment')$$, '42501', '3a inspector cannot mark test apartment');
select pg_temp.expect_error($$update public.properties set is_test = true where id = '0000000b-0000-4000-8000-0000000000f1'$$, '42501', '3b no direct column update');
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', true, 'x')$$, '22023', '3c reason required');
select pg_temp.expect_error($$select public.set_property_test_status('0000000c-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-0000000000b9', true, 'Cross company')$$, '42501', '3d cannot mark another company apartment');
select pg_temp.expect_error($$select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000b9', true, 'Mismatched pair')$$, '42501', '3e company/property mismatch refused');
select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', true, 'Training apartment');
select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', true, 'Repeat is a no-op');
select pg_temp.ok((select count(*) = 1 from public.audit_events where event_kind = 'property_test_status_changed' and entity_id = '0000000b-0000-4000-8000-0000000000f1'), '3f exactly one audit row (repeat is a no-op)');
select pg_temp.expect_error($$insert into public.audit_events(company_id, actor_id, event_kind) values ('0000000c-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000a1', 'test_session_started')$$, '42501', '3g client cannot forge test audit events');

-- ---------- 4. any flag on a test apartment is a test flag, for anyone ----------
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a2');
insert into t_ids values ('on_test_apartment', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', false, null));
select pg_temp.ok((select is_test and test_reason = 'test_property' from public.flags where id = (select v from t_ids where k = 'on_test_apartment')), '4 inspector flag on test apartment is test (client false ignored)');

-- ---------- 5. test sessions ----------
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', 60, 'Unit 13 test')$$, '42501', '5a inspector cannot start test mode');
select pg_temp.expect_error($$insert into public.test_sessions(company_id, user_id, property_id, ends_at, reason) values ('0000000c-0000-4000-8000-00000000000a', auth.uid(), '0000000b-0000-4000-8000-000000000013', now() + interval '1 hour', 'sneaky')$$, '42501', '5b no direct insert');
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', 241, 'Unit 13 test')$$, '22023', '5c max 4 hours');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', null, 60, 'Unit 13 test')$$, '22023', '5c2 an apartment is required');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-0000000000b9', 60, 'Unit 13 test')$$, '42501', '5d cannot start in another company');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000b9', 60, 'Mismatched pair')$$, '42501', '5d2 apartment of another company refused');
select pg_temp.ok(public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', 60, 'Unit 13 test') is not null, '5e start on Unit 13');
select pg_temp.ok((select count(*) = 1 and bool_and(property_id = '0000000b-0000-4000-8000-000000000013') from public.test_sessions where ended_at is null), '5f one open session, on Unit 13');
select pg_temp.ok(public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', 30, 'double tap') = (select ends_at from public.test_sessions where ended_at is null), '5g idempotent: same session returned');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000014', 30, 'other apartment')$$, '55000', '5g2 a second apartment is refused while one is running');
select pg_temp.ok((select count(*) = 1 from public.test_sessions), '5h still one session');
select pg_temp.ok((select count(*) = 1 from public.audit_events where event_kind = 'test_session_started'), '5i one start audit');
select pg_temp.expect_error($$select public.in_test_session('0000000c-0000-4000-8000-00000000000a', auth.uid(), '0000000b-0000-4000-8000-000000000013')$$, '42501', '5j in_test_session not callable by clients');

-- manager in test mode raises an issue on REAL Unit 13 -> test
insert into t_ids values ('session_flag', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select is_test and test_reason = 'test_session' from public.flags where id = (select v from t_ids where k = 'session_flag')), '5k session flag on real apartment is test');
-- the SAME manager raising a genuine issue on ANOTHER apartment stays live
insert into t_ids values ('session_other_apartment', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000014'));
select pg_temp.ok((select not is_test and test_reason is null from public.flags where id = (select v from t_ids where k = 'session_other_apartment')), '5k2 manager in test mode: other apartment is NOT test');
-- inspector on the same apartment at the same time is NOT affected
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a2');
insert into t_ids values ('other_person', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select not is_test from public.flags where id = (select v from t_ids where k = 'other_person')), '5l other staff unaffected');
-- classification is immutable even for the owner of the session
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$update public.flags set is_test = false, test_reason = null where id = (select v from t_ids where k = 'session_flag')$$, '42501', '5m cannot un-test a flag');
-- ordinary edits still work on test flags
update public.flags set severity = 'high' where id = (select v from t_ids where k = 'session_flag');
select pg_temp.ok((select severity = 'high' from public.flags where id = (select v from t_ids where k = 'session_flag')), '5n ordinary update allowed');
-- demoting the manager mid-session stops the session applying at once
reset role;
update public.company_memberships set role_key = 'inspector' where user_id = '00000000-0000-4000-8000-0000000000a1';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
insert into t_ids values ('demoted', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select not is_test from public.flags where id = (select v from t_ids where k = 'demoted')), '5n2 demoted manager session no longer applies');
reset role;
update public.company_memberships set role_key = 'ops_manager' where user_id = '00000000-0000-4000-8000-0000000000a1';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
-- end session; next flag is normal again
select public.end_test_session('0000000c-0000-4000-8000-00000000000a');
select public.end_test_session('0000000c-0000-4000-8000-00000000000a');
select pg_temp.ok((select count(*) = 1 from public.audit_events where event_kind = 'test_session_ended'), '5o one end audit (second end is a no-op)');
insert into t_ids values ('after_end', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select not is_test from public.flags where id = (select v from t_ids where k = 'after_end')), '5p after ending, flags are normal');

-- ---------- 6. outbox backstop ----------
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.live.create_task_for_flag', 'flag', (select v from t_ids where k = 'session_flag'), auth.uid())$$, '23514', '6a live create job refused for test flag');
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.live.attach_flag_evidence', 'flag', (select v from t_ids where k = 'on_test_apartment'), auth.uid())$$, '23514', '6b live attach job refused for test flag');
insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by)
  values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.create_task_for_flag', 'flag', (select v from t_ids where k = 'session_flag'), auth.uid());
select pg_temp.ok((select count(*) = 1 from public.integration_outbox where entity_id = (select v from t_ids where k = 'session_flag')), '6c BETA job allowed for test flag');
insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by)
  values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.live.create_task_for_flag', 'flag', (select v from t_ids where k = 'after_end'), auth.uid());
select pg_temp.ok((select count(*) = 1 from public.integration_outbox where entity_id = (select v from t_ids where k = 'after_end')), '6d live job still allowed for a normal flag');

-- the rule does not depend on provider / entity_type / letter case
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana_other', 'asana.live.create_task_for_flag', 'inspection', (select v from t_ids where k = 'on_test_apartment'), auth.uid())$$, '23514', '6e other provider/entity_type still refused');
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'ASANA.LIVE.create_task_for_flag', 'flag', (select v from t_ids where k = 'on_test_apartment'), auth.uid())$$, '23514', '6f upper-case event type still refused');

-- worker (service role, no user) cannot re-point or revive a live job for a test flag
reset role;
set local role service_role;
select pg_temp.expect_error($$update public.integration_outbox set entity_id = (select v from t_ids where k = 'on_test_apartment') where entity_id = (select v from t_ids where k = 'after_end')$$, '23514', '6g entity_id re-point refused');
select pg_temp.expect_error($$update public.integration_outbox set event_type = 'asana.live.create_task_for_flag' where entity_id = (select v from t_ids where k = 'session_flag')$$, '23514', '6h event_type change BETA -> live refused');
-- a soft-deleted live job may exist (fixture written as owner); reviving it is refused
reset role;
insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by, deleted_at)
  values ('0000000c-0000-4000-8000-00000000000a', 'other', 'asana.live.create_task_for_flag', 'other', (select v from t_ids where k = 'on_test_apartment'), '00000000-0000-4000-8000-0000000000a1', now());
set local role service_role;
select pg_temp.expect_error($$update public.integration_outbox set deleted_at = null where entity_id = (select v from t_ids where k = 'on_test_apartment') and deleted_at is not null$$, '23514', '6i deleted_at revive refused');
select pg_temp.expect_error($$update public.integration_outbox set deleted_at = null, provider = 'asana', entity_type = 'flag' where entity_id = (select v from t_ids where k = 'on_test_apartment') and deleted_at is not null$$, '23514', '6j revive with provider/entity_type change refused');
reset role;
select pg_temp.ok((select array_agg(a.attname::text order by a.attname::text) = array['company_id','deleted_at','entity_id','entity_type','event_type','provider']
  from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
  where t.tgname = 'trg_outbox_refuse_live_for_test_flags'), '6k trigger re-checks updates of all six columns');

-- ---------- 7. no user (server/worker insert): property classification still applies ----------
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.flags(company_id, property_id, flag_category_id, raised_by, description)
  values ('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000a2', 'server insert');
select pg_temp.ok((select is_test and test_reason = 'test_property' from public.flags where description = 'server insert'), '7 server-side insert on test apartment is test');

-- ---------- 8. new properties are never born test; unmark works and is audited ----------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
-- Either the insert is refused outright (column-scoped INSERT grant, as on
-- the shared database since 20261122174325) or the row is forced to normal.
do $$ begin
  begin
    insert into public.properties(id, company_id, name, is_test) values ('0000000b-0000-4000-8000-0000000000f9', '0000000c-0000-4000-8000-00000000000a', 'Sneaky', true);
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.ok(not exists (select 1 from public.properties where id = '0000000b-0000-4000-8000-0000000000f9' and is_test), '8a insert cannot create a test apartment');
end $$;
select public.set_property_test_status('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', false, 'Back to normal');
select pg_temp.ok((select count(*) = 2 from public.audit_events where event_kind = 'property_test_status_changed'), '8b unmark audited');
-- existing test flags stay test after unmarking (history is not rewritten)
select pg_temp.ok((select is_test from public.flags where id = (select v from t_ids where k = 'on_test_apartment')), '8c history kept after unmark');

-- ---------- 9. expiry ----------
reset role;
update public.test_sessions set started_at = now() - interval '2 hours', ends_at = now() - interval '1 hour', ended_at = null
  where id = (select id from public.test_sessions limit 1);
select pg_temp.ok(not public.in_test_session('0000000c-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000a1', '0000000b-0000-4000-8000-000000000013'), '9a expired session is inactive');
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
insert into t_ids values ('expired', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
select pg_temp.ok((select not is_test from public.flags where id = (select v from t_ids where k = 'expired')), '9b flag after expiry is normal');
select pg_temp.ok(public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000014', 30, 'New run') > now(), '9c new session after expiry, another apartment allowed (expired one closed)');
select pg_temp.ok((select count(*) = 1 from public.test_sessions where ended_at is null), '9d exactly one open');

-- ---------- 10. reconciliation of issues that never reached Asana ----------
reset role;
-- company B has Asana off: its new flags are not expected in Asana
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000b1');
insert into t_ids values ('b_flag', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-0000000000b9'));
select pg_temp.ok((select not asana_handoff_expected from public.flags where id = (select v from t_ids where k = 'b_flag')), '10a Asana off: handoff not expected');
select pg_temp.expect_error($$select * from public.asana_flags_awaiting_handoff(10, 0)$$, '42501', '10b clients cannot call the reconciliation lookup');
reset role;
set local role service_role;
select pg_temp.ok((select count(*) = 0 from public.asana_flags_awaiting_handoff(50, 120)), '10c fresh issues are left to the app for 2 minutes');
select pg_temp.ok((select v from t_ids where k = 'normal') in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10d normal flag with no job is awaiting');
select pg_temp.ok((select v from t_ids where k = 'session_flag') not in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10e flag with a job is not awaiting');
reset role;
insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by, deleted_at)
  values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.create_task_for_flag', 'flag', (select v from t_ids where k = 'other_person'), '00000000-0000-4000-8000-0000000000a2', now());
set local role service_role;
select pg_temp.ok((select v from t_ids where k = 'other_person') not in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10f a soft-deleted Asana job counts as handled (never recreated)');
select pg_temp.ok((select v from t_ids where k = 'demoted') in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10f2 control: a flag without any job is awaiting');
select pg_temp.ok((select v from t_ids where k = 'b_flag') not in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10g Asana-off company excluded');
select pg_temp.ok((select is_test and not is_pack_photo_issue and not has_photos and category_key = 'maintenance_issue' from public.asana_flags_awaiting_handoff(50, 0) where flag_id = (select id from public.flags where description = 'server insert')), '10h test flag awaiting, with its routing facts');
select pg_temp.ok((select not is_test from public.asana_flags_awaiting_handoff(50, 0) where flag_id = (select v from t_ids where k = 'normal')), '10i classification reported as stored');
-- the worker's enqueue function: narrow, validated, idempotent
create or replace function pg_temp.job(p_flag uuid, p_event text, p_flag_in_payload uuid default null, p_company uuid default '0000000c-0000-4000-8000-00000000000a')
returns jsonb language sql as $$
  select jsonb_build_object('company_id', p_company, 'provider', 'asana', 'event_type', p_event, 'entity_type', 'flag',
    'entity_id', p_flag, 'created_by', '00000000-0000-4000-8000-0000000000b1',
    'payload', jsonb_build_object('flag_id', coalesce(p_flag_in_payload, p_flag), 'create_protocol', 2))
$$;
grant execute on function pg_temp.job(uuid, text, uuid, uuid) to authenticated, service_role;
reset role;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag')))$$, '42501', '10j clients cannot call the enqueue function');
reset role;
set local role service_role;
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'other_person'), 'asana.live.create_task_for_flag')))$$, '22023', '10k job for another flag refused');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag', (select v from t_ids where k = 'other_person'))))$$, '22023', '10l payload flag_id mismatch refused');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag'), pg_temp.job((select v from t_ids where k = 'normal'), 'asana.attach_flag_evidence')))$$, '22023', '10m mixed destinations refused');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.attach_flag_evidence')))$$, '22023', '10n attach without create refused');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag', null, '0000000c-0000-4000-8000-00000000000b')))$$, '22023', '10o other company refused');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select id from public.flags where description = 'server insert'), jsonb_build_array(pg_temp.job((select id from public.flags where description = 'server insert'), 'asana.live.create_task_for_flag')))$$, '23514', '10p live destination for a test flag refused');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'b_flag'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'b_flag'), 'asana.create_task_for_flag', null, '0000000c-0000-4000-8000-00000000000b'))) = 'not_expected', '10q Asana-off flag: not_expected, nothing written');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.attach_flag_evidence'), pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag'))) = 'enqueued', '10r enqueued (create + attach)');
select pg_temp.ok((select count(*) = 2 and bool_and(created_by = '00000000-0000-4000-8000-0000000000a2') and bool_and(status = 'pending') from public.integration_outbox where entity_id = (select v from t_ids where k = 'normal')), '10s two jobs, created_by = reporter (input ignored)');
select pg_temp.ok((select v from t_ids where k = 'normal') not in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '10t enqueued flag no longer awaiting');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'normal'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'normal'), 'asana.live.create_task_for_flag'))) = 'already_has_job', '10u repeat (lost response / retry) is a no-op');
select pg_temp.ok((select count(*) = 2 from public.integration_outbox where entity_id = (select v from t_ids where k = 'normal')), '10v still exactly two jobs');
select pg_temp.ok(public.enqueue_asana_handoff((select id from public.flags where description = 'server insert'), jsonb_build_array(pg_temp.job((select id from public.flags where description = 'server insert'), 'asana.create_task_for_flag'))) = 'enqueued', '10w test flag enqueued to BETA');
reset role;
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.create_task_for_flag', 'flag', (select v from t_ids where k = 'normal'), '00000000-0000-4000-8000-0000000000a2')$$, '23505', '10x any second create job (other destination) refused by the database');
-- deleted flags and flags older than 14 days are not reconciled
reset role;
update public.flags set deleted_at = now() where id = (select v from t_ids where k = 'expired');
alter table public.flags disable trigger trg_flags_set_updated_at;
update public.flags set created_at = now() - interval '15 days' where id = (select v from t_ids where k = 'after_end') or id = (select v from t_ids where k = 'forged_handoff');
alter table public.flags enable trigger trg_flags_set_updated_at;
set local role service_role;
select pg_temp.ok((select count(*) = 0 from public.asana_flags_awaiting_handoff(50, 0) where flag_id in (select v from t_ids where k in ('expired', 'forged_handoff'))), '10y deleted and >14-day-old flags excluded');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'expired'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'expired'), 'asana.live.create_task_for_flag'))) = 'not_expected', '10z deleted flag: not_expected');
-- disabling Asana for the company stops reconciliation
reset role;
update public.integration_settings set is_enabled = false where company_id = '0000000c-0000-4000-8000-00000000000a';
set local role service_role;
select pg_temp.ok((select count(*) = 0 from public.asana_flags_awaiting_handoff(50, 0)), '10za Asana switched off: nothing reconciled');
reset role;
update public.integration_settings set is_enabled = true where company_id = '0000000c-0000-4000-8000-00000000000a';

-- ---------- 11. history and issues already in Asana are never (re)sent ----------
reset role;
-- historical issues (created before the migration): simulate by inserting
-- with the stamping trigger off, so the marker keeps its column default
alter table public.flags disable trigger trg_flags_stamp_test_classification;
insert into public.flags(id, company_id, property_id, flag_category_id, raised_by, description, is_test, test_reason) values
  ('0000000f-0000-4000-8000-0000000000e1', '0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000a2', 'historical normal', false, null),
  ('0000000f-0000-4000-8000-0000000000e2', '0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000a2', 'historical test', true, 'test_property');
alter table public.flags enable trigger trg_flags_stamp_test_classification;
-- new issues that already reached Asana by another route
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a2');
insert into t_ids values ('has_url', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
insert into t_ids values ('has_link', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000013'));
update public.flags set asana_task_url = 'https://app.asana.com/0/1/2' where id = (select v from t_ids where k = 'has_url');
reset role;
insert into public.external_task_links(company_id, provider, internal_entity_type, internal_entity_id, external_task_gid, deleted_at)
  values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'flag', (select v from t_ids where k = 'has_link'), '1234567890', now());
set local role service_role;
select pg_temp.ok((select count(*) = 0 from public.asana_flags_awaiting_handoff(50, 0)
  where flag_id in ('0000000f-0000-4000-8000-0000000000e1', '0000000f-0000-4000-8000-0000000000e2')), '11a historical issues (normal and test) never awaited');
select pg_temp.ok(public.enqueue_asana_handoff('0000000f-0000-4000-8000-0000000000e1', jsonb_build_array(pg_temp.job('0000000f-0000-4000-8000-0000000000e1', 'asana.live.create_task_for_flag'))) = 'not_expected', '11b historical normal issue: enqueue refused (not_expected)');
select pg_temp.ok(public.enqueue_asana_handoff('0000000f-0000-4000-8000-0000000000e2', jsonb_build_array(pg_temp.job('0000000f-0000-4000-8000-0000000000e2', 'asana.create_task_for_flag'))) = 'not_expected', '11c historical test issue: enqueue refused (not_expected)');
select pg_temp.ok((select count(*) = 0 from public.asana_flags_awaiting_handoff(50, 0)
  where flag_id in (select v from t_ids where k in ('has_url', 'has_link'))), '11d issues with a saved task link or task-link record (even removed) never awaited');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'has_url'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'has_url'), 'asana.live.create_task_for_flag'))) = 'already_has_job', '11e task link: enqueue is a no-op');
select pg_temp.ok(public.enqueue_asana_handoff((select v from t_ids where k = 'has_link'), jsonb_build_array(pg_temp.job((select v from t_ids where k = 'has_link'), 'asana.live.create_task_for_flag'))) = 'already_has_job', '11f task-link record: enqueue is a no-op');
select pg_temp.ok((select count(*) = 0 from public.integration_outbox where entity_id in
  ('0000000f-0000-4000-8000-0000000000e1', '0000000f-0000-4000-8000-0000000000e2', (select v from t_ids where k = 'has_url'), (select v from t_ids where k = 'has_link'))), '11g nothing written for any of them');
-- an existing job is never modified by reconciliation (insert-only)
select pg_temp.ok((select count(*) = 2 and bool_and(status = 'pending') and bool_and(event_type like 'asana.live.%') from public.integration_outbox where entity_id = (select v from t_ids where k = 'normal')), '11h existing jobs unchanged (no reroute)');
reset role;

-- ---------- 12. reads are company-scoped ----------
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000b1');
select pg_temp.ok((select count(*) = 0 from public.test_sessions), '12 other company sees no sessions');

-- ---------- 13. Asana handoff health (manager early warning) ----------
reset role;
insert into auth.users(id, email) values ('00000000-0000-4000-8000-0000000000c1', 'mgr@c.test'), ('00000000-0000-4000-8000-0000000000c2', 'insp@c.test');
insert into public.profiles(id, email) values ('00000000-0000-4000-8000-0000000000c1', 'mgr@c.test'), ('00000000-0000-4000-8000-0000000000c2', 'insp@c.test') on conflict (id) do nothing;
insert into public.companies(id, name) values ('0000000c-0000-4000-8000-00000000000c', 'Company C');
insert into public.company_memberships(company_id, user_id, role_key) values
  ('0000000c-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-0000000000c1', 'gm'),
  ('0000000c-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-0000000000c2', 'inspector');
insert into public.integration_settings(company_id, provider, is_enabled) values ('0000000c-0000-4000-8000-00000000000c', 'asana', true);
insert into public.properties(id, company_id, name) values
  ('0000000b-0000-4000-8000-0000000000c1', '0000000c-0000-4000-8000-00000000000c', 'C Unit 1'),
  ('0000000b-0000-4000-8000-0000000000c2', '0000000c-0000-4000-8000-00000000000c', 'C Training');
update public.properties set is_test = true where id = '0000000b-0000-4000-8000-0000000000c2';
-- c1 missing 20 min | c2 missing 15 days (beyond retry) | c3 fresh 5 min (not reported)
-- c4 stopped (dead job) | c5 stuck (pending 40 min) | c6 queued 5 min (fine) | c7 TEST missing (excluded)
-- c8 deleted (excluded) | c9 has task url (excluded) | ca only a soft-deleted job (removed on purpose)
insert into public.flags(id, company_id, property_id, flag_category_id, raised_by, description, created_at) values
  ('0000000f-0000-4000-8000-0000000000c1', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'guest Jane Doe broke the lamp', now() - interval '20 minutes'),
  ('0000000f-0000-4000-8000-0000000000c2', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'old', now() - interval '15 days'),
  ('0000000f-0000-4000-8000-0000000000c3', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'fresh', now() - interval '5 minutes'),
  ('0000000f-0000-4000-8000-0000000000c4', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'dead job', now() - interval '1 hour'),
  ('0000000f-0000-4000-8000-0000000000c5', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'stuck job', now() - interval '55 minutes'),
  ('0000000f-0000-4000-8000-0000000000c6', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'queued', now() - interval '6 minutes'),
  ('0000000f-0000-4000-8000-0000000000c7', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c2', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'test', now() - interval '1 hour'),
  ('0000000f-0000-4000-8000-0000000000c8', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'deleted', now() - interval '1 hour'),
  ('0000000f-0000-4000-8000-0000000000c9', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'has url', now() - interval '1 hour'),
  ('0000000f-0000-4000-8000-0000000000ca', '0000000c-0000-4000-8000-00000000000c', '0000000b-0000-4000-8000-0000000000c1', (select id from public.flag_categories where key = 'maintenance_issue'), '00000000-0000-4000-8000-0000000000c2', 'removed job', now() - interval '1 hour');
update public.flags set deleted_at = now() where id = '0000000f-0000-4000-8000-0000000000c8';
update public.flags set asana_task_url = 'https://app.asana.com/0/1/3' where id = '0000000f-0000-4000-8000-0000000000c9';
insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by, status, created_at, deleted_at) values
  ('0000000c-0000-4000-8000-00000000000c', 'asana', 'asana.live.create_task_for_flag', 'flag', '0000000f-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000c2', 'dead', now() - interval '50 minutes', null),
  ('0000000c-0000-4000-8000-00000000000c', 'asana', 'asana.live.create_task_for_flag', 'flag', '0000000f-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000c2', 'pending', now() - interval '40 minutes', null),
  ('0000000c-0000-4000-8000-00000000000c', 'asana', 'asana.live.create_task_for_flag', 'flag', '0000000f-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-0000000000c2', 'pending', now() - interval '5 minutes', null),
  ('0000000c-0000-4000-8000-00000000000c', 'asana', 'asana.create_task_for_flag', 'flag', '0000000f-0000-4000-8000-0000000000ca', '00000000-0000-4000-8000-0000000000c2', 'pending', now() - interval '50 minutes', now());
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c2');
select pg_temp.expect_error($$select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c')$$, '42501', '13a inspectors cannot read handoff health');
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c')$$, '42501', '13b another company''s manager cannot read it');
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select pg_temp.ok((select (h->>'missing')::int = 2 and (h->>'missing_beyond_retry')::int = 1 and (h->>'stopped')::int = 1 and (h->>'stuck')::int = 1
  and (h->>'asana_enabled')::boolean and h->'last_check_at' = 'null'::jsonb and (h->>'monitoring_since') is not null
  from (select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c') h) x), '13c counts: 2 missing (1 beyond retry), 1 stopped, 1 stuck; fresh/queued/test/deleted/linked/removed excluded; worker never ran, monitoring start known');
select pg_temp.ok((select jsonb_array_length(h->'items') = 4
  and (select array_agg(i->>'problem' order by i->>'raised_at') from jsonb_array_elements(h->'items') i) = array['missing', 'stopped', 'stuck', 'missing']::text[]
  and not exists (select 1 from jsonb_array_elements(h->'items') i where i ? 'description' or i ? 'raised_by' or i::text ilike '%Jane%')
  and (h->>'oldest_problem_at')::timestamptz < now() - interval '14 days'
  from (select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c') h) x), '13d items: problem, apartment and time only; no descriptions, reporter or guest data');
select pg_temp.expect_error($$select * from public.integration_worker_heartbeats$$, '42501', '13e clients cannot read the heartbeat table');
select pg_temp.expect_error($$select public.record_worker_heartbeat('asana_reconcile', true)$$, '42501', '13f clients cannot write a heartbeat');
reset role;
create temp table t_since on commit drop as select monitoring_since from public.integration_worker_heartbeats where worker = 'asana_reconcile';
set local role service_role;
select public.record_worker_heartbeat('asana_reconcile', true);
reset role;
select pg_temp.ok((select h.monitoring_since = t.monitoring_since and h.last_run_at is not null and h.last_ok from public.integration_worker_heartbeats h, t_since t where h.worker = 'asana_reconcile'), '13f2 a run keeps the monitoring start and records the run');
set local role service_role;
select pg_temp.expect_error($$select public.record_worker_heartbeat('other_worker', true)$$, '23514', '13g only the known worker name');
reset role;
update public.integration_worker_heartbeats set last_run_at = now() - interval '1 hour', last_ok_at = now() - interval '1 hour';
set local role service_role;
select public.record_worker_heartbeat('asana_reconcile', false);
reset role;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select pg_temp.ok((select (h->>'last_check_ok')::boolean = false and (h->>'last_check_at')::timestamptz >= now() - interval '1 minute'
  and (h->>'last_check_ok_at')::timestamptz < now() - interval '59 minutes'
  from (select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c') h) x), '13h failed run recorded; last success time kept');
reset role;
update public.integration_settings set is_enabled = false where company_id = '0000000c-0000-4000-8000-00000000000c';
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select pg_temp.ok((select not (h->>'asana_enabled')::boolean from (select public.asana_handoff_health('0000000c-0000-4000-8000-00000000000c') h) x), '13i reports when Asana is switched off for the company');
reset role;

-- ---------- 14. SAFE recovery keeps every guard on ----------
-- (block below is verbatim from supabase/ops/test-activity-isolation/02_safe_recovery.sql;
--  src/lib/testing/ops-scripts.test.ts fails if they ever differ)
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000014', 60, 'before recovery') is not null;
reset role;
create temp table t_before on commit drop as select id, is_test, test_reason, asana_handoff_expected from public.flags;
-- ===== SAFE LEVERS (begin) =====
revoke execute on function public.asana_flags_awaiting_handoff(integer, integer) from service_role;
revoke execute on function public.enqueue_asana_handoff(uuid, jsonb) from service_role;
revoke execute on function public.start_test_session(uuid, uuid, integer, text) from authenticated;
with ended as (
  update public.test_sessions set ended_at = least(now(), ends_at)
   where ended_at is null
  returning id, company_id, property_id
)
insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, metadata)
select company_id, null, 'test_session_ended', 'test_session', id,
       jsonb_build_object('property_id', property_id, 'source', 'safe recovery lever B')
  from ended;
-- ===== SAFE LEVERS (end) =====
select pg_temp.ok((select count(*) = 2 from pg_trigger where tgenabled = 'O'
  and tgname in ('trg_flags_stamp_test_classification', 'trg_outbox_refuse_live_for_test_flags')), '14a both guards still enabled');
select pg_temp.ok((select count(*) = 0 from public.test_sessions where ended_at is null), '14b running test mode ended');
select pg_temp.ok((select count(*) >= 1 from public.audit_events where event_kind = 'test_session_ended' and metadata->>'source' = 'safe recovery lever B'), '14c ending is audited');
select pg_temp.ok(not exists (select 1 from t_before b join public.flags f using (id)
  where f.is_test is distinct from b.is_test or f.test_reason is distinct from b.test_reason or f.asana_handoff_expected is distinct from b.asana_handoff_expected), '14d no classification changed');
-- a new issue on the test apartment is still a test issue, still expected, and still cannot go live
-- (Test 1 was made normal in section 8; mark it test again, as the release step would)
update public.properties set is_test = true where id = '0000000b-0000-4000-8000-0000000000f1' and not is_test;
set local role authenticated;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a2');
insert into t_ids values ('after_recovery2', pg_temp.raise_flag('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-0000000000f1'));
select pg_temp.ok((select is_test and test_reason = 'test_property' and asana_handoff_expected from public.flags where id = (select v from t_ids where k = 'after_recovery2')), '14e new test-apartment issue still classified and expected');
select pg_temp.expect_error($$update public.flags set is_test = false, test_reason = null where id = (select v from t_ids where k = 'after_recovery2')$$, '42501', '14f classification still immutable');
select pg_temp.expect_error($$insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, created_by) values ('0000000c-0000-4000-8000-00000000000a', 'asana', 'asana.live.create_task_for_flag', 'flag', (select v from t_ids where k = 'after_recovery2'), auth.uid())$$, '23514', '14g live job for a test issue still refused (old app behaviour)');
select pg_temp.act_as('00000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$select public.start_test_session('0000000c-0000-4000-8000-00000000000a', '0000000b-0000-4000-8000-000000000014', 60, 'after recovery')$$, '42501', '14h test mode cannot be started');
reset role;
set local role service_role;
select pg_temp.expect_error($$select * from public.asana_flags_awaiting_handoff(10, 0)$$, '42501', '14i reconciliation stopped (lookup)');
select pg_temp.expect_error($$select public.enqueue_asana_handoff((select v from t_ids where k = 'after_recovery2'), '[]'::jsonb)$$, '42501', '14j reconciliation stopped (enqueue)');
reset role;
-- RESTORE (the commented statements in the script) brings it back
grant execute on function public.asana_flags_awaiting_handoff(integer, integer) to service_role;
grant execute on function public.enqueue_asana_handoff(uuid, jsonb) to service_role;
grant execute on function public.start_test_session(uuid, uuid, integer, text) to authenticated;
set local role service_role;
select pg_temp.ok((select v from t_ids where k = 'after_recovery2') in (select flag_id from public.asana_flags_awaiting_handoff(50, 0)), '14k after restore the waiting test issue is picked up again');
reset role;

-- ---------- 15. the hazardous emergency script refuses without acknowledgement ----------
select pg_temp.expect_error($q$do $x$ begin
  if current_setting('test_isolation.hazard_acknowledged', true) is distinct from 'test issues may reach live Asana' then
    raise exception 'Refusing: read the hazards in this file and set the acknowledgement first';
  end if; end $x$$q$, 'P0001', '15 emergency script refuses without the acknowledgement');

reset role;
select 'TEST ACTIVITY ISOLATION: ALL PASSED' as result;
rollback;
