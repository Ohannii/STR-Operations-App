// Disposable local PostgreSQL only. The Vault test shim verifies SQL contracts,
// not hosted encryption. No Hostaway/network/staff-database calls are made.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

const url = new URL(process.env.STR_TEST_DATABASE_URL ?? 'postgres://localhost/postgres')
if (!process.env.STR_TEST_DATABASE_URL || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable local PostgreSQL URL required; remote hosts refused.')
const root = new URL('../../', import.meta.url), name = `str_pms_test_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Client({ connectionString: url.href }), clients = []
let created = false, checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS: ${label}`) }
const value = result => Object.values(result.rows[0])[0]
const id = (kind, n) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CO = id(1, 1), CO2 = id(1, 2), A = id(2, 1), B = id(2, 2), I = id(2, 3), REMOVED = id(2, 4)
const BL = id(3, 1), BV = id(3, 2), OTHER = id(3, 3), UNUSED = id(3, 4)
async function role(db, roleName, actor, sql, args = []) {
  await db.query('begin')
  try {
    await db.query(`set local role ${roleName}`)
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [actor ?? ''])
    const result = await db.query(sql, args); await db.query('commit'); return value(result)
  } catch (error) { await db.query('rollback'); throw error }
}
async function refuses(run, code, label) { await assert.rejects(run, error => error.code === code, label); checks++; console.log(`PASS: ${label}`) }
async function waitForBlock(observer, blocked, blocker) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (value(await observer.query('select $2::int=any(pg_blocking_pids($1))', [blocked.processID, blocker.processID]))) return
    await delay(10)
  }
  throw Error('Expected real database contention was not observed')
}
const saveSql = "select save_hostaway_connection($1,$2,$3,$4,now()+interval '1 year',$5)"
const mappingSql = 'select save_hostaway_mapping($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
try {
  await admin.connect(); await admin.query(`create database "${name}"`); created = true; url.pathname = `/${name}`
  for (let n = 0; n < 3; n++) { const db = new pg.Client({ connectionString: url.href, statement_timeout: 10000 }); await db.connect(); clients.push(db) }
  const [db, a, b] = clients
  await db.query(await readFile(new URL('supabase/tests/local_platform.sql', root), 'utf8'))
  for (const file of (await readdir(new URL('supabase/migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`supabase/migrations/${file}`, root), 'utf8'))
  }
  console.log('Applied every repository migration to fresh local PostgreSQL (test-only Vault shim)')
  await db.query(`
    insert into auth.users(id,email) select ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'pms-fixture'||i||'@example.invalid' from generate_series(1,4) i;
    insert into companies(id,name) values('${CO}','Company A fixture'),('${CO2}','Company B fixture');
    insert into company_memberships(company_id,user_id,role_key,is_active) values
      ('${CO}','${A}','company_admin',true),('${CO2}','${B}','company_admin',true),('${CO}','${I}','inspector',true),('${CO}','${REMOVED}','company_admin',false);
    insert into properties(id,company_id,name,address) values
      ('${BL}','${CO}','Unit 91','Ballito Life'),('${BV}','${CO}','Unit 91','Ballito Village'),
      ('${OTHER}','${CO2}','Unit 91','Ballito Life'),('${UNUSED}','${CO}','Unused fixture','Ballito Life');
  `)
  const save = (client, company, actor, account, revision, token = 'synthetic-fixture-token') => role(client, 'service_role', null, saveSql, [company, actor, account, token, revision])
  const first = await save(db, CO, A, '123', 0)
  check(typeof first === 'string', 'service-only save accepts the actual active company admin')
  const secret = value(await db.query('select credential_id from pms_connections where id=$1', [first]))
  check(value(await db.query('select decrypted_secret from vault.decrypted_secrets where id=$1', [secret])) === 'synthetic-fixture-token', 'token uses Vault API contract; no API client secret stored')
  for (const r of ['anon', 'authenticated']) {
    await refuses(() => role(db, r, A, saveSql, [CO, A, '123', 'synthetic-forgery-token', 1]), '42501', `${r} cannot execute credential save even with a real admin UUID`)
    await refuses(() => role(db, r, A, 'select read_hostaway_setup_token($1,$2,$3,1)', [CO, A, first]), '42501', `${r} cannot execute token read`)
    await refuses(() => role(db, r, A, 'select decrypted_secret from vault.decrypted_secrets limit 1'), '42501', `${r} cannot read Vault`)
  }
  for (const actor of [B, I, REMOVED, null]) await refuses(() => save(db, CO, actor, '123', 1), '42501', `service RPC rechecks company/admin/active actor ${actor ?? 'null'}`)
  await refuses(() => save(db, CO2, A, '123', 0), '42501', 'company A actor cannot connect company B')
  check(await role(db, 'authenticated', A, 'select count(*)::int from pms_connections where company_id=$1', [CO]) === 1, 'admin can read safe connection metadata')
  for (const user of [I, B]) check(await role(db, 'authenticated', user, 'select count(*)::int from pms_connections where company_id=$1', [CO]) === 0, 'inspector/foreign admin sees no connection metadata')
  await refuses(() => role(db, 'authenticated', A, 'select credential_id from pms_connections where id=$1', [first]), '42501', 'admin cannot read credential reference column')
  for (const table of ['pms_connections', 'pms_listing_mappings']) {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      for (const r of ['authenticated', 'service_role', 'anon']) check(!value(await db.query('select has_table_privilege($1,$2,$3)', [r, table, privilege])), `${r} has no direct ${privilege} on ${table}`)
    }
  }
  await refuses(() => save(db, CO, A, '999', 1), '55000', 'different Hostaway account cannot inherit existing mappings')
  await refuses(() => save(db, CO, A, '123', 0), '40001', 'lost-response/stale connection save is refused')
  await save(db, CO, A, '123', 1, 'synthetic-rotated-token')
  check(value(await db.query('select count(*)::int from vault.secrets')) === 1, 'rotation updates existing Vault secret instead of leaking old local secrets')
  check(await role(db, 'service_role', null, 'select read_hostaway_setup_token($1,$2,$3,2)', [CO, A, first]) === 'synthetic-rotated-token', 'current exact revision reads rotated token')
  await refuses(() => role(db, 'service_role', null, 'select read_hostaway_setup_token($1,$2,$3,1)', [CO, A, first]), '55000', 'stale revision cannot read current token')
  await refuses(() => role(db, 'service_role', null, 'select read_hostaway_setup_token($1,$2,$3,2)', [CO2, B, first]), '55000', 'foreign admin cannot read another connection token')
  const map = (client, listing, unit, property, revision = 0, connRev = 2, company = CO, actor = A) => role(client, 'service_role', null, mappingSql,
    [company, actor, first, connRev, listing, unit, property, 'Verified fixture listing', unit === '0' ? null : 'Verified fixture unit', 'Africa/Johannesburg', revision])
  await refuses(() => map(db, '91', '0', OTHER), '42501', 'cross-company apartment mapping is refused')
  await refuses(() => map(db, '91', '0', BL, 0, 1), '40001', 'mapping cannot save across a rotated connection revision')
  await refuses(() => map(db, '91', '0', BL, 0, 2, CO2, B), '55000', 'foreign connection scope refused')
  const blMap = await map(db, '91', '0', BL)
  await map(db, '92', '7', BV)
  check(value(await db.query('select count(distinct property_id)::int from pms_listing_mappings where company_id=$1', [CO])) === 2, 'BL91 and BV91 remain distinct physical apartment UUIDs')
  await refuses(() => map(db, '91', '0', BV), '40001', 'stale mapping edit is refused')
  await refuses(() => map(db, '93', '0', BL), '23505', 'second listing cannot silently map to the same physical apartment')
  await refuses(() => map(db, '91', '8', UNUSED), '23505', 'parent listing and physical subunit cannot both be mapped')
  await refuses(() => map(db, '92', '0', UNUSED), '23505', 'subunit and parent cannot both be mapped in reverse order')
  check(await role(db, 'authenticated', I, 'select count(*)::int from pms_listing_mappings') === 0, 'mapping metadata is admin-only')
  check(await role(db, 'authenticated', B, 'select count(*)::int from pms_listing_mappings') === 0, 'mapping RLS isolates companies')
  await refuses(() => role(db, 'authenticated', A, "insert into audit_events(company_id,actor_id,event_kind) values($1,$2,'pms_mapping_verified') returning id", [CO, A]), '42501', 'client cannot forge PMS verification audit')
  check(!value(await db.query("select exists(select 1 from audit_events where metadata::text like '%synthetic-%')")), 'audit metadata contains no tokens or client secrets')

  // Force actual two-connection contention, not sequential fake interleavings.
  await a.query('begin'); await a.query('set local role service_role')
  await a.query(saveSql, [CO, A, '123', 'synthetic-race-winner-token', 2])
  const competing = save(b, CO, A, '123', 2, 'synthetic-race-loser-token')
  const observed = competing.catch(error => error)
  await waitForBlock(db, b, a); await a.query('commit')
  check((await observed).code === '40001', 'simultaneous credential rotations serialize and reject stale loser')
  check(value(await db.query('select revision::int from pms_connections where id=$1', [first])) === 3, 'one concurrent credential change commits')
  await a.query('begin'); await a.query('set local role service_role')
  await a.query(mappingSql, [CO, A, first, 3, '91', '0', BL, 'Winner mapping name', null, 'Africa/Johannesburg', 1])
  const mappingRace = map(b, '91', '0', UNUSED, 1, 3).catch(error => error)
  await waitForBlock(db, b, a); await a.query('commit')
  check((await mappingRace).code === '40001', 'simultaneous mapping edits serialize and reject stale loser')
  check(value(await db.query('select property_id from pms_listing_mappings where id=$1', [blMap])) === BL, 'mapping race never replaces the winner with a stale target')
  await db.query('update company_memberships set is_active=false where company_id=$1 and user_id=$2', [CO, A])
  await refuses(() => role(db, 'service_role', null, 'select read_hostaway_setup_token($1,$2,$3,3)', [CO, A, first]), '42501', 'revoked admin cannot read cached connection credentials')
  await db.query('update company_memberships set is_active=true where company_id=$1 and user_id=$2', [CO, A])
  await refuses(() => role(db, 'service_role', null, 'select disconnect_hostaway_connection($1,$2,$3,2)', [CO, A, first]), '40001', 'stale disconnect cannot erase a newer connection')
  await role(db, 'service_role', null, 'select disconnect_hostaway_connection($1,$2,$3,3)', [CO, A, first])
  check(value(await db.query('select count(*)::int from vault.secrets')) === 0, 'disconnect removes the local Vault secret')
  check(value(await db.query("select status='disconnected' and credential_id is null and revision=4 from pms_connections where id=$1", [first])), 'disconnect marks connection and invalidates revision')
  check(value(await db.query('select count(*)::int from pms_listing_mappings')) === 2, 'disconnect retains verified apartment mappings')
  await refuses(() => map(db, '94', '0', UNUSED, 0, 4), '55000', 'disconnected accounts cannot add mappings')
  await save(db, CO, A, '123', 4, 'synthetic-reconnect-token')
  check(value(await db.query('select count(*)::int from vault.secrets')) === 1, 'same-account reconnect creates only one local secret')
  check(value(await db.query('select count(*)::int from turnover_jobs')) === 0, 'setup creates no inspection schedules')
  check(value(await db.query('select count(*)::int from evidence_packs')) === 0, 'setup creates no packs or ghost completions')
  console.log(`${checks} PMS database checks passed`)
} finally {
  for (const db of clients) { try { await db.query('rollback'); await db.end() } catch { /* original error wins */ } }
  if (created) await admin.query(`drop database "${name}" with (force)`)
  await admin.end()
}
