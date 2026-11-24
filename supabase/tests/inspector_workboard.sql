-- Run ONLY in a disposable local database with repo migrations applied.
-- Fixtures, role changes and assertions are rolled back together.
begin;
create function pg_temp.assert_test(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label; end $$;
create function pg_temp.expect_error(statement text, expected text, label text) returns void language plpgsql as $$
declare got text;
begin
  begin execute statement; exception when others then got:=sqlstate; end;
  if got is distinct from expected then raise exception 'FAIL: % expected %, got %',label,expected,got; end if;
  raise notice 'PASS: %',label;
end $$;
insert into auth.users(id,email) select ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'fixture'||i||'@example.invalid' from generate_series(1,6) i;
insert into public.profiles(id,full_name) select ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Inspector fixture '||i from generate_series(1,6) i
  on conflict(id) do update set full_name=excluded.full_name;
insert into public.companies(id,name) values('10000000-0000-4000-8000-000000000001','Company A fixture'),('20000000-0000-4000-8000-000000000001','Company B fixture');
insert into public.company_memberships(company_id,user_id,role_key,is_active) values
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','inspector',true),
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','inspector',true),
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','ops_manager',true),
 ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004','inspector',true),
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000005','finance',true),
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000006','inspector',false);
insert into public.properties(id,company_id,name,address,status) values
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Unit 91','Ballito Life','needs_attention'),
 ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Unit 91','Ballito Village','idle'),
 ('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','Unit 91','Ballito Village','idle');

set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
select pg_temp.assert_test(jsonb_array_length(public.inspection_workspace('10000000-0000-4000-8000-000000000001')->'properties')=2,'only own-company properties, including BL and BV 91');
select pg_temp.assert_test((public.inspection_workspace('10000000-0000-4000-8000-000000000001')->>'managers_only')::boolean=false,'default open policy');
select pg_temp.assert_test(jsonb_array_length(public.inspection_workspace('10000000-0000-4000-8000-000000000001')->'inspectors')=3,'roster excludes foreign, finance and inactive users');
select pg_temp.expect_error($q$select public.inspection_workspace('20000000-0000-4000-8000-000000000001')$q$,'42501','foreign workspace denied');
select pg_temp.expect_error($q$insert into property_assignments(company_id,property_id,user_id) values('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001')$q$,'42501','raw assignment write denied');
select pg_temp.expect_error($q$insert into audit_events(company_id,actor_id,event_kind) values('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','primary_inspector_reassigned')$q$,'42501','client cannot forge allocation history');
select pg_temp.assert_test(public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":0}]','30000000-0000-4000-8000-000000000001')=1,'inspector can assign under open policy');
select pg_temp.assert_test(public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":1}]','30000000-0000-4000-8000-000000000001')=0,'identical assignment does not create another audit event');
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":0}]',null)$q$,'40001','stale edit refused');
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000002","revision":0},{"property_id":"40000000-0000-4000-8000-000000000003","revision":0}]','30000000-0000-4000-8000-000000000001')$q$,'42501','bulk cross-company change refused');
select pg_temp.assert_test((select primary_inspector_revision=0 from properties where id='40000000-0000-4000-8000-000000000002'),'bulk failure rolls back earlier same-company write');
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000002","revision":0}]','30000000-0000-4000-8000-000000000004')$q$,'22023','foreign inspector refused');
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000002","revision":0}]','30000000-0000-4000-8000-000000000006')$q$,'22023','inactive inspector refused');
select pg_temp.expect_error($q$select public.set_inspection_reassignment_policy('10000000-0000-4000-8000-000000000001',true,0)$q$,'42501','inspector cannot change policy');

select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
insert into public.properties(company_id,name) values('10000000-0000-4000-8000-000000000001','Manager create fixture');
select pg_temp.assert_test(exists(select 1 from properties where name='Manager create fixture' and primary_inspector_revision=0),'existing manager property form still works');
select pg_temp.expect_error($q$insert into properties(company_id,name,primary_inspector_revision) values('10000000-0000-4000-8000-000000000001','Forged revision',5)$q$,'42501','property INSERT cannot forge assignment revision');
select pg_temp.expect_error($q$update properties set primary_inspector_revision=5 where id='40000000-0000-4000-8000-000000000001'$q$,'42501','property UPDATE cannot forge assignment revision');
select public.set_inspection_reassignment_policy('10000000-0000-4000-8000-000000000001',true,0);
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000002","revision":0}]','30000000-0000-4000-8000-000000000001')$q$,'42501','manager-only policy enforced in database');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":1}]','30000000-0000-4000-8000-000000000002');
select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":2}]','30000000-0000-4000-8000-000000000001');
select pg_temp.expect_error($q$select public.assign_primary_inspectors('10000000-0000-4000-8000-000000000001','[{"property_id":"40000000-0000-4000-8000-000000000001","revision":1}]',null)$q$,'40001','A-B-A reassignment still invalidates stale form');
select pg_temp.assert_test((select count(*)=3 from audit_events where event_kind='primary_inspector_reassigned' and company_id='10000000-0000-4000-8000-000000000001'),'each actual reassignment audited exactly once');
select pg_temp.assert_test((public.inspection_workspace('10000000-0000-4000-8000-000000000001')->'history'->0->>'actor') is not null,'allocation audit names visible');

select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','2026-11-22','2026-11-22 10:00+02','2026-11-22 14:00+02');
select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','2026-11-22','2026-11-22 10:00+02','2026-11-22 14:00+02');
select pg_temp.assert_test((select count(*)=1 from turnover_jobs where company_id='10000000-0000-4000-8000-000000000001'),'schedule replay creates one job');
select pg_temp.expect_error($q$select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','2026-11-23','2026-11-22 10:00+02','2026-11-22 14:00+02')$q$,'23505','different nonce/date cannot duplicate same checkout');
select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','2026-11-24',null,null);
select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','2026-11-22','2026-11-22 18:00+02',null);
select pg_temp.assert_test((select count(*)=3 from turnover_jobs where property_id='40000000-0000-4000-8000-000000000001'),'separate dates and distinct same-day checkouts remain separate');
select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000002','2026-11-24',null,null);
select public.update_turnover_schedule('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004',0,'2026-11-25',false);
select pg_temp.expect_error($q$select public.update_turnover_schedule('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004',0,'2026-11-26',true)$q$,'40001','stale schedule edit refused');
select public.update_turnover_schedule('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004',1,'2026-11-25',true);
select pg_temp.expect_error($q$select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004')$q$,'42501','cancelled inspection cannot start');
select pg_temp.expect_error($q$select public.schedule_turnover('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000002','2026-11-24',null,null)$q$,'55000','lost-response replay never claims a cancelled schedule is active');

select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
select pg_temp.expect_error($q$select public.inspection_workboard('10000000-0000-4000-8000-000000000001',true)$q$,'42501','inspector cannot request manager overview');
select pg_temp.assert_test((select count(*)=0 from turnover_jobs where company_id='10000000-0000-4000-8000-000000000001'),'direct table RLS hides other inspectors jobs');
select pg_temp.assert_test(jsonb_array_length(public.inspection_workboard('10000000-0000-4000-8000-000000000001',false,'40000000-0000-4000-8000-000000000001'))=3,'B can open A apartment work without claiming or reassigning it');
select pg_temp.expect_error($q$select public.inspection_workboard('10000000-0000-4000-8000-000000000001',false,'40000000-0000-4000-8000-000000000003')$q$,'42501','property-specific view still rejects another company');
select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001');
select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001');
select pg_temp.assert_test((select count(*)=1 from evidence_packs where property_id='40000000-0000-4000-8000-000000000001'),'repeated Start creates one pack');
select pg_temp.assert_test((select started_by='30000000-0000-4000-8000-000000000002'::uuid from evidence_packs where property_id='40000000-0000-4000-8000-000000000001'),'B starting A allocated unit credits B');
select pg_temp.expect_error($q$select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002')$q$,'55000','another visit cannot adopt an unrelated open draft');
select pg_temp.assert_test(jsonb_array_length(public.inspection_workboard('10000000-0000-4000-8000-000000000001',false))=1,'B sees their started pack without taking permanent allocation');

reset role;
insert into public.evidence_packs(id,company_id,property_id,pack_type,started_by) values
 ('80000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','pre_arrival','30000000-0000-4000-8000-000000000004');
select pg_temp.expect_error($q$update public.turnover_jobs set pack_id='80000000-0000-4000-8000-000000000001' where id='50000000-0000-4000-8000-000000000001'$q$,'23503','database FK rejects a foreign-company pack even for trusted imports');
insert into public.photos(id,company_id,property_id,evidence_pack_id,storage_path,thumbnail_path,notes,entity_type,retention_class,uploaded_by)
 select '60000000-0000-4000-8000-000000000001',company_id,property_id,pack_id,'fixture/master.jpg','fixture/thumb.jpg','before','pre_arrival','routine_pre_arrival','30000000-0000-4000-8000-000000000002'
 from turnover_jobs where id='50000000-0000-4000-8000-000000000001';
insert into public.photo_upload_intents(id,company_id,property_id,evidence_pack_id,master_path,thumb_path,state,created_by)
 select '60000000-0000-4000-8000-000000000001',company_id,property_id,pack_id,'fixture/master.jpg','fixture/thumb.jpg','pending','30000000-0000-4000-8000-000000000002'
 from turnover_jobs where id='50000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.expect_error($q$select submit_prearrival_pack_with_captions((select pack_id from turnover_jobs where id='50000000-0000-4000-8000-000000000001'),'[{"photo_id":"60000000-0000-4000-8000-000000000001","expected_note":"before","note":"after"}]')$q$,'23514','existing submit refuses unresolved photos');
select pg_temp.assert_test((select notes='before' from photos where id='60000000-0000-4000-8000-000000000001'),'failed submission rolls back captions');
reset role;
update public.photo_upload_intents set state='completed',completed_at=now() where id='60000000-0000-4000-8000-000000000001';
insert into storage.objects(bucket_id,name) values('evidence-photos','fixture/master.jpg'),('evidence-photos','fixture/thumb.jpg');
set local role authenticated;
select pg_temp.assert_test(public.submit_prearrival_pack_with_captions((select pack_id from turnover_jobs where id='50000000-0000-4000-8000-000000000001'),'[{"photo_id":"60000000-0000-4000-8000-000000000001","expected_note":"before","note":"after"}]')='submitted','ordinary caption submission completes the linked job');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
select pg_temp.assert_test(public.submit_prearrival_pack_with_captions((select pack_id from turnover_jobs where id='50000000-0000-4000-8000-000000000001'),'[{"photo_id":"60000000-0000-4000-8000-000000000001","expected_note":"before","note":"after"}]')='already_submitted','lost-response replay stays idempotent');
select pg_temp.assert_test((select submitted_by='30000000-0000-4000-8000-000000000002'::uuid from evidence_packs where property_id='40000000-0000-4000-8000-000000000001'),'replay by A does not overwrite B as submitter');
select pg_temp.assert_test((select user_id='30000000-0000-4000-8000-000000000001'::uuid from property_assignments where property_id='40000000-0000-4000-8000-000000000001' and deleted_at is null),'primary allocation stays A after B submits');
select pg_temp.assert_test((select status='needs_attention' from properties where id='40000000-0000-4000-8000-000000000001'),'submission does not clear readiness blockers');
select pg_temp.assert_test(exists(select 1 from jsonb_array_elements(public.inspection_workboard('10000000-0000-4000-8000-000000000001',false)) x where x->>'submitted_by'='30000000-0000-4000-8000-000000000002'),'A sees actual completion by B');
select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002');
select pg_temp.assert_test((select count(distinct pack_id)=2 from turnover_jobs where id in ('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002')),'next turnover has its own pack, never inherits old completion');

select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',true);
select pg_temp.expect_error($q$select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002')$q$,'42501','other-company user cannot start a job');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000005',true);
select pg_temp.expect_error($q$select public.inspection_workspace('10000000-0000-4000-8000-000000000001')$q$,'42501','finance cannot use inspector administration');
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000006',true);
select pg_temp.expect_error($q$select public.inspection_workspace('10000000-0000-4000-8000-000000000001')$q$,'42501','inactive membership cannot use inspector workspace');
reset role;
set local role anon;
select pg_temp.expect_error($q$select public.inspection_workspace('10000000-0000-4000-8000-000000000001')$q$,'42501','anonymous cannot call inspection RPC');
select pg_temp.expect_error('select * from public.turnover_jobs','42501','anonymous cannot read jobs');
reset role;
set local role service_role;
select pg_temp.expect_error('truncate public.turnover_jobs','42501','worker has no table mutation grant');
select pg_temp.expect_error($q$select public.start_turnover_job('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002')$q$,'42501','worker cannot impersonate inspector');
rollback;
