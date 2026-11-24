import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Release-safety contract for the test-isolation operations scripts.
 * The SAFE recovery must never weaken a guard; the hazardous emergency
 * script must refuse to run without an explicit acknowledgement; and the
 * database acceptance test must exercise the SAFE block exactly as shipped.
 */
const ops = (f: string) => readFileSync(join(process.cwd(), 'supabase/ops/test-activity-isolation', f), 'utf8').replace(/\r\n/g, '\n')
const sqlTest = readFileSync(join(process.cwd(), 'supabase/tests/test_activity_isolation_test.sql'), 'utf8').replace(/\r\n/g, '\n')
const between = (text: string, begin: string, end: string) => {
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  expect(i).toBeGreaterThanOrEqual(0)
  expect(j).toBeGreaterThan(i)
  return text.slice(i, j + end.length)
}
const executable = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase()

describe('02_safe_recovery.sql', () => {
  const safe = ops('02_safe_recovery.sql')
  const levers = between(safe, '-- ===== SAFE LEVERS (begin) =====', '-- ===== SAFE LEVERS (end) =====')
  it('never disables a trigger, drops, deletes, truncates or rewrites classifications', () => {
    const sql = executable(safe)
    for (const banned of ['disable trigger', 'drop ', 'delete ', 'truncate', 'alter table', 'set is_test', 'asana_handoff_expected =', 'test_reason =']) {
      expect(sql).not.toContain(banned)
    }
  })
  it('the levers only revoke the automation, end test mode with an audit row, and nothing else', () => {
    const statements = executable(levers).split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^revoke execute on function public\.asana_flags_awaiting_handoff\(integer, integer\) from service_role$/)
    expect(statements[1]).toMatch(/^revoke execute on function public\.enqueue_asana_handoff\(uuid, jsonb\) from service_role$/)
    expect(statements[2]).toMatch(/^revoke execute on function public\.start_test_session\(uuid, uuid, integer, text\) from authenticated$/)
    expect(statements[3]).toMatch(/^with ended as \(\s*update public\.test_sessions set ended_at/)
    expect(statements[3]).toContain("'test_session_ended'")
  })
  it('the database acceptance test runs the SAFE levers verbatim', () => {
    expect(sqlTest).toContain(levers)
  })
  it('says plainly that the normal rollback is an app rollback that keeps the guards', () => {
    expect(safe).toContain('THE NORMAL ROLLBACK IS AN APP ROLLBACK, NOT A DATABASE CHANGE')
    expect(safe).toContain('the database still refuses any live Asana job for a test issue')
  })
})

describe('03_emergency_disable_classification.sql (hazardous)', () => {
  const em = ops('03_emergency_disable_classification.sql')
  const sql = executable(em)
  it('refuses before doing anything unless the hazard is acknowledged', () => {
    const guard = sql.indexOf("current_setting('test_isolation.hazard_acknowledged', true) is distinct from 'test issues may reach live asana'")
    const action = sql.indexOf('disable trigger')
    expect(guard).toBeGreaterThan(-1)
    expect(action).toBeGreaterThan(guard)
    expect(sqlTest).toContain("current_setting('test_isolation.hazard_acknowledged', true) is distinct from 'test issues may reach live Asana'")
  })
  it('disables ONLY the classification trigger and leaves the live-job veto on', () => {
    expect(sql.match(/disable trigger/g)).toHaveLength(1)
    expect(sql).toContain('alter table public.flags disable trigger trg_flags_stamp_test_classification;')
    expect(sql).not.toContain('trg_outbox_refuse_live_for_test_flags')
  })
  it('requires EVERY live routing path off, including the preview test switch', () => {
    expect(em).toContain('Switch EVERY live Asana routing path off')
    expect(em).toMatch(/ASANA_LIVE_INCIDENTS_ENABLED\s+-> anything other than "true"/)
    expect(em).toMatch(/ASANA_LIVE_INCIDENTS_TEST\s+-> anything other than "true"/)
  })
  it('states its hazards and the required preconditions', () => {
    for (const text of ['NOT A ROLLBACK', 'NEVER RUN ROUTINELY', 'EXPLICIT APPROVAL', 'PERMANENTLY mis-recorded', 'IRREVERSIBLE DATA EFFECT',
      'CAN reach the live Asana', 'Stop all testing', 'NOT retried and NOT reported']) {
      expect(em).toContain(text)
    }
  })
})

describe('release_2_apply_PROPOSED.sql (production release transaction)', () => {
  const rel = ops('release_2_apply_PROPOSED.sql')
  const repo = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
  const embedded = (open: string, close: string) => {
    const i = rel.indexOf(open)
    const j = rel.indexOf(close, i + open.length)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    return rel.slice(i + open.length, j)
  }
  it('embeds the migration and the marking script byte-for-byte (no drift from the reviewed files)', () => {
    expect(embedded('m text := $mig$', '$mig$;')).toBe(repo('supabase/migrations/20261123120000_test_activity_isolation.sql'))
    expect(embedded('k text := $mark$', '$mark$;')).toBe(ops('01_mark_test_apartments.sql'))
  })
  it('guards both texts by their reviewed checksums before executing anything', () => {
    const sql = executable(rel)
    const guard1 = sql.indexOf("'422bc93d9dede32ceb9f5944173c770083f27c5cdb79ede7621b0c99e7c7381a'")
    const guard2 = sql.indexOf("'dc68c65639f49e8b7e248349c928f46baf47fc8289f95ade2b22afaa2ccb7853'")
    const exec = sql.indexOf('execute m;')
    expect(guard1).toBeGreaterThan(-1)
    expect(guard2).toBeGreaterThan(-1)
    expect(exec).toBeGreaterThan(Math.max(guard1, guard2))
  })
  it('refuses unless the history matches the APPROVED preflight fingerprint, checked before executing anything', () => {
    const sql = executable(rel)
    const fp = sql.indexOf("v_fp <> 'a7dd154116a9b381d2d5e1cc4c369e3612e7b640ab4433982786a54382fe8e56'")
    expect(fp).toBeGreaterThan(-1)
    expect(sql.indexOf('execute m;')).toBeGreaterThan(fp)
    // same expression as the preflight's history_fingerprint
    const expr = (t: string) => t.slice(t.indexOf("quote_nullable(version) || '|'"), t.indexOf("e'\\n' order by version)")).replace(/\s+/g, ' ')
    expect(expr(sql).length).toBeGreaterThan(150)
    expect(expr(sql)).toBe(expr(executable(ops('release_1_preflight_readonly.sql'))))
  })
  it('requires exactly one active "Test 1" and exactly one active "Test 2" (not just two in total) before executing', () => {
    const sql = executable(rel)
    const one = sql.indexOf("name = 'test 1') <> 1")
    const two = sql.indexOf("name = 'test 2') <> 1")
    expect(one).toBeGreaterThan(-1)
    expect(two).toBeGreaterThan(-1)
    expect(sql.indexOf('execute m;')).toBeGreaterThan(Math.max(one, two))
  })
  it('records the FULL migration SQL in history, never a placeholder comment', () => {
    expect(executable(rel)).toContain("values ('20261123120000', 'test_activity_isolation', array[m]);")
  })
  it('is a single DO block (one transaction) with no transaction control or trigger disabling', () => {
    const sql = executable(rel)
    expect(sql.match(/^do \$rel\$/gm)).toHaveLength(1)
    for (const banned of ['commit;', 'rollback;', 'disable trigger']) expect(sql.replace(/\$mig\$[\s\S]*?\$mig\$/, '').replace(/\$mark\$[\s\S]*?\$mark\$/, '')).not.toContain(banned)
  })
})

describe('release_3_postflight_readonly.sql', () => {
  const post = executable(ops('release_3_postflight_readonly.sql'))
  it('only counts issues created BEFORE the release as reclassified; later issues are informational', () => {
    expect(post).toContain("where flags.created_at < release.at and (flags.is_test or flags.asana_handoff_expected)) as reclassified_preexisting_flags")
    expect(post).toContain('as flags_created_since_release')
    expect(post).not.toContain('reclassified_existing_flags')
  })
})
