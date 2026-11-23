-- ============================================================
-- Test activity isolation — release data step (NOT a migration)
-- ============================================================
-- Marks the Drop-Inn training apartments "Test 1" and "Test 2" as test
-- apartments. Needs its own explicit approval.
--
-- RUN IN THE SAME TRANSACTION AS migration 20261123120000, straight after
-- it. Then there is no moment in which the database has test isolation but
-- Test 1 / Test 2 are not yet marked:
--
--   begin;
--   <contents of supabase/migrations/20261123120000_test_activity_isolation.sql>
--   <contents of this file>
--   commit;
--
-- Safe to re-run: already-marked apartments are skipped and no second audit
-- row is written. Refuses to run unless it finds exactly the two active
-- apartments by name in the Drop-Inn company. Writes the same audit event
-- as the in-app Testing page. No credentials or personal data.
do $$
declare v_count int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'properties' and column_name = 'is_test') then
    raise exception 'migration 20261123120000 is not applied';
  end if;
  select count(*) into v_count from public.properties
   where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
     and deleted_at is null and name in ('Test 1', 'Test 2');
  if v_count <> 2 then
    raise exception 'expected exactly the active apartments Test 1 and Test 2, found %', v_count;
  end if;
end $$;

with changed as (
  update public.properties set is_test = true
   where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7'
     and deleted_at is null and name in ('Test 1', 'Test 2') and not is_test
  returning id
)
insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, before, after, metadata)
select '1669c464-8d26-40fc-9956-9f8955fd27c7', null, 'property_test_status_changed', 'property', id,
       '{"is_test": false}'::jsonb, '{"is_test": true}'::jsonb,
       '{"reason": "Training apartment, not a real unit", "source": "release step 01_mark_test_apartments"}'::jsonb
  from changed;
