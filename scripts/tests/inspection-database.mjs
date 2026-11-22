// This runner creates and drops ONLY its own randomly named database on a local
// throwaway PostgreSQL server. It never accepts a remote/staff database address.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

const url = new URL(process.env.STR_TEST_DATABASE_URL ?? 'postgres://localhost/postgres')
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !process.env.STR_TEST_DATABASE_URL) {
  throw Error('Set STR_TEST_DATABASE_URL to a disposable local PostgreSQL server; remote hosts are refused.')
}
const root = new URL('../../', import.meta.url)
const name = `str_workboard_test_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Client({ connectionString: url.href })
const clients = []
let created = false, checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS: ${label}`) }
const value = result => Object.values(result.rows[0])[0]
async function asUser(db, user, sql, args = []) {
  await db.query('begin')
  try {
    await db.query('set local role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user])
    const result = await db.query(sql, args)
    await db.query('commit')
    return value(result)
  } catch (e) { await db.query('rollback'); throw e }
}
async function refuses(action, code, label) {
  await assert.rejects(action, error => error.code === code, label)
  checks++; console.log(`PASS: ${label}`)
}
// Synchronise against a real database wait, not a guessed sleep duration.
async function waitForBlock(observer, blocked, blocker) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (value(await observer.query('select $2::int=any(pg_blocking_pids($1))', [blocked.processID, blocker.processID]))) return
    await delay(10)
  }
  throw Error('Expected database contention was not observed')
}
const CO = '10000000-0000-4000-8000-000000000001'
const CO2 = '20000000-0000-4000-8000-000000000001'
const id = (kind, n) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = id(3, 1), B = id(3, 2), M = id(3, 3), X = id(3, 4)
const P = n => id(4, n), J = n => id(5, n)

try {
  await admin.connect()
  await admin.query(`create database "${name}"`)
  created = true
  url.pathname = `/${name}`
  for (let i = 0; i < 3; i++) {
    const client = new pg.Client({ connectionString: url.href, statement_timeout: 10000 })
    await client.connect(); clients.push(client)
  }
  const [db, a, b] = clients
  await db.query(await readFile(new URL('supabase/tests/local_platform.sql', root), 'utf8'))
  const migrations = new URL('supabase/migrations/', root)
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, migrations), 'utf8'))
  }
  console.log('Applied every repository migration to a fresh local database')
  let sqlChecks = 0
  db.on('notice', notice => { if (notice.message.startsWith('PASS:')) sqlChecks++ })
  await db.query(await readFile(new URL('supabase/tests/inspector_workboard.sql', root), 'utf8'))
  check(sqlChecks >= 52, `${sqlChecks} SQL lifecycle/role assertions passed`)
  await db.query(`
    insert into auth.users(id,email) select ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'fixture'||i||'@example.invalid' from generate_series(1,4) i;
    update profiles set full_name=case id when '${A}' then 'Inspector A' when '${B}' then 'Inspector B' else 'Manager' end;
    insert into companies(id,name) values('${CO}','Company A fixture'),('${CO2}','Company B fixture');
    insert into company_memberships(company_id,user_id,role_key) values
      ('${CO}','${A}','inspector'),('${CO}','${B}','inspector'),('${CO}','${M}','ops_manager'),('${CO2}','${X}','company_admin');
    insert into properties(id,company_id,name,address) select ('40000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
      '${CO}','Unit '||i,case when i%2=0 then 'Ballito Village' else 'Ballito Life' end from generate_series(1,12) i;
  `)
  const schedule = (client, job, prop, day = '2026-11-22', checkout = null) => asUser(client, M, 'select schedule_turnover($1,$2,$3,$4,$5,null)', [CO, job, prop, day, checkout])
  const start = (client, user, job) => asUser(client, user, 'select start_turnover_job($1,$2)', [CO, job])
  const board = user => asUser(db, user, 'select inspection_workboard($1,false,null)', [CO])
  const update = (user, job, revision, cancel, day = '2026-11-22') => asUser(db, user, 'select update_turnover_schedule($1,$2,$3,$4,$5)', [CO, job, revision, day, cancel])
  const assign = (client, prop, rev, user) => asUser(client, M, 'select assign_primary_inspectors($1,$2::jsonb,$3)', [CO, JSON.stringify([{ property_id: prop, revision: rev }]), user])

  await schedule(db, J(1), P(1))
  await schedule(db, J(1), P(1))
  await refuses(() => asUser(db, A, "insert into audit_events(company_id,actor_id,event_kind) values($1,$2,'turnover_scheduled') returning id", [CO, A]), '42501', 'client cannot forge schedule creation audit')
  check(value(await db.query("select not has_function_privilege('anon','public.inspection_has_available_primary(uuid,uuid)','execute')")), 'new read helper denies anonymous execution')
  check(await asUser(db, X, 'select inspection_has_available_primary($1,$2)', [CO, P(1)]) === false, 'new read helper reveals no foreign-tenant allocation')
  check(value(await db.query("select count(*)::int from audit_events where event_kind='turnover_scheduled' and entity_id=$1", [J(1)])) === 1, 'scheduling retry audits only one creation')
  check((await board(A)).some(j => j.id === J(1)), 'unallocated job appears in inspector default list')
  check((await board(M)).some(j => j.id === J(1)), 'unallocated job appears in manager default list')
  check(await asUser(db, B, 'select count(*)::int from turnover_jobs where id=$1', [J(1)]) === 1, 'direct RLS agrees for unallocated jobs')
  await assign(db, P(1), 0, A)
  check(!(await board(B)).some(j => j.id === J(1)), 'another active inspector’s allocated job stays out of My work')
  check(await asUser(db, B, 'select count(*)::int from turnover_jobs where id=$1', [J(1)]) === 0, 'RLS does not mistake a hidden membership/profile for an unavailable assignee')
  await db.query('update company_memberships set is_active=false where company_id=$1 and user_id=$2', [CO, A])
  check((await board(B)).some(j => j.id === J(1)), 'unavailable primary inspector makes open work visible')
  check(await asUser(db, B, 'select count(*)::int from turnover_jobs where id=$1', [J(1)]) === 1, 'direct RLS also handles unavailable primary inspector')
  await db.query('update company_memberships set is_active=true where company_id=$1 and user_id=$2', [CO, A])
  await refuses(() => board(X), '42501', 'other tenant cannot use default work list')

  const discarded = await start(db, A, J(1))
  await asUser(db, A, 'update evidence_packs set deleted_at=now() where id=$1 returning id', [discarded])
  await refuses(() => start(db, B, J(1)), '55000', 'discard does not imply a new pack or completion')
  await refuses(() => update(A, J(1), 1, true), '42501', 'inspector cannot cancel discarded work')
  await refuses(() => update(M, J(1), 1, false, '2026-11-23'), '55000', 'discarded linked job cannot be rescheduled/relinked')
  await refuses(() => schedule(db, J(2), P(1)), '23505', 'replacement remains blocked until manager cancels')
  await update(M, J(1), 1, true, '2026-11-23')
  const old = (await asUser(db, M, 'select inspection_workboard($1,true,null)', [CO])).find(j => j.id === J(1))
  check(old.cancelled_at && old.pack_id === discarded && old.pack_deleted && old.due_on === '2026-11-22', 'cancel clears discarded visit while retaining pack and original due date')
  await schedule(db, J(2), P(1))
  check(await start(db, A, J(2)) !== discarded, 'same-day replacement starts a distinct pack after cancellation')
  await refuses(() => update(M, J(2), 1, true), '55000', 'a live draft still cannot be cancelled through schedule controls')

  await schedule(db, J(3), P(2))
  const ordinary = await asUser(db, A, "insert into evidence_packs(company_id,property_id,pack_type,started_by) values ($1,$2,'pre_arrival',$3) returning id", [CO, P(2), A])
  await assert.rejects(() => start(db, A, J(3)), e => e.code === '55000' && e.message === 'existing draft')
  checks++; console.log('PASS: unrelated older draft is refused with a distinct error')
  async function submit(pack, prop, user, number) {
    const photo = id(6, number), path = `fixture/${number}`
    await db.query(`insert into photos(id,company_id,property_id,evidence_pack_id,storage_path,thumbnail_path,entity_type,retention_class,uploaded_by)
      values($1,$2,$3,$4,$5,$6,'pre_arrival','routine_pre_arrival',$7)`, [photo, CO, prop, pack, `${path}/master.jpg`, `${path}/thumb.jpg`, user])
    await db.query(`insert into photo_upload_intents(id,company_id,property_id,evidence_pack_id,master_path,thumb_path,state,created_by,completed_at)
      values($1,$2,$3,$4,$5,$6,'completed',$7,now())`, [photo, CO, prop, pack, `${path}/master.jpg`, `${path}/thumb.jpg`, user])
    await db.query("insert into storage.objects(bucket_id,name) values('evidence-photos',$1),('evidence-photos',$2)", [`${path}/master.jpg`, `${path}/thumb.jpg`])
    const manifest = JSON.stringify([{ photo_id: photo, expected_note: '', note: 'Checked' }])
    check(await asUser(db, user, 'select submit_prearrival_pack_with_captions($1,$2::jsonb)', [pack, manifest]) === 'submitted', 'actual caption RPC submits the pack')
    return manifest
  }
  await submit(ordinary, P(2), A, 1)
  check((await board(A)).find(j => j.id === J(3)).pack_id === null, 'unrelated ordinary submission never completes scheduled work')
  const linked = await start(db, A, J(3))
  const manifest = await submit(linked, P(2), B, 2)
  const completed = (await board(B)).find(j => j.id === J(3))
  check(completed.started_by === A && completed.submitted_by === B && completed.starter_name === 'Inspector A' && completed.submitter_name === 'Inspector B', 'A starts and B submits: both actual authors survive in workboard')
  check(await asUser(db, A, 'select submit_prearrival_pack_with_captions($1,$2::jsonb)', [linked, manifest]) === 'already_submitted', 'lost response replay by starter does not overwrite submitter')
  check(!(await board(M)).some(j => j.id === J(3)), 'unassigned completed history is not broadcast to unrelated My work lists')
  await refuses(() => update(M, J(3), 1, true), '55000', 'completed inspection cannot be cancelled')

  // Real concurrent calls, not sequential mocks of the SQL policy.
  await schedule(db, J(4), P(3))
  await a.query('begin'); await a.query('set local role authenticated')
  await a.query("select set_config('request.jwt.claim.sub',$1,true)", [A])
  const first = value(await a.query('select start_turnover_job($1,$2)', [CO, J(4)]))
  const second = start(b, B, J(4))
  await waitForBlock(db, b, a)
  await a.query('commit')
  check(await second === first, 'two simultaneous Starts return one pack and retain original starter')

  await schedule(db, J(5), P(4), '2026-11-22', '2026-11-22T08:00:00Z')
  await schedule(db, J(6), P(4), '2026-11-22', '2026-11-22T16:00:00Z')
  const results = await Promise.allSettled([start(a, A, J(5)), start(b, B, J(6))])
  check(results.filter(r => r.status === 'fulfilled').length === 1 && results.some(r => r.status === 'rejected' && ['55000', '23505'].includes(r.reason.code)), 'different visits on one property still produce only one open draft')
  await schedule(db, J(7), P(5))
  const ordinaryRace = await Promise.allSettled([start(a, A, J(7)), asUser(b, B, "insert into evidence_packs(company_id,property_id,pack_type,started_by) values($1,$2,'pre_arrival',$3) returning id", [CO, P(5), B])])
  check(ordinaryRace.filter(r => r.status === 'fulfilled').length === 1, 'ordinary Start racing scheduled Start leaves one draft')
  const schedules = await Promise.allSettled([schedule(a, J(8), P(6)), schedule(b, J(9), P(6))])
  check(schedules.filter(r => r.status === 'fulfilled').length === 1 && schedules.some(r => r.status === 'rejected' && r.reason.code === '23505'), 'same-day concurrent manual schedules create one job')
  const assignments = await Promise.allSettled([assign(a, P(7), 0, A), assign(b, P(7), 0, B)])
  check(assignments.filter(r => r.status === 'fulfilled').length === 1 && assignments.some(r => r.status === 'rejected' && r.reason.code === '40001'), 'competing allocations reject stale revision')
  check(value(await db.query("select count(*)::int from audit_events where event_kind='primary_inspector_reassigned' and entity_id=$1", [P(7)])) === 1, 'concurrent allocations create one audit entry')

  // Force the real Start RPC to pause just after its property FOR SHARE lock.
  // A test-only trigger is installed in this disposable DB, never in migrations.
  await db.query(`create function public.test_pause_pack() returns trigger language plpgsql as $$ begin
    if new.property_id='${P(8)}' then perform pg_advisory_xact_lock(740022); end if; return new; end $$;
    create trigger test_pause_pack before insert on evidence_packs for each row execute function public.test_pause_pack();`)
  await schedule(db, J(10), P(8))
  await db.query('select pg_advisory_lock(740022)')
  const blockedStart = start(a, B, J(10))
  await waitForBlock(db, a, db)
  const blockedAssignment = assign(b, P(8), 0, A)
  await waitForBlock(db, b, a)
  await db.query('select pg_advisory_unlock(740022)')
  const lockResults = await Promise.all([blockedStart, blockedAssignment])
  check(typeof lockResults[0] === 'string' && lockResults[1] === 1, 'real Start and allocation both commit under forced formerly-deadlocking ordering')
  await db.query('drop trigger test_pause_pack on evidence_packs; drop function test_pause_pack()')
  console.log(`${checks} runner checks and ${sqlChecks} SQL assertions passed`)
} finally {
  // Release held transactions before closing, including when a race test fails.
  for (const client of clients) { try { await client.query('rollback'); await client.end() } catch { /* original failure wins */ } }
  if (created) await admin.query(`drop database "${name}" with (force)`)
  await admin.end()
}
