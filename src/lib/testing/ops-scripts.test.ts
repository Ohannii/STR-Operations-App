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
  it('states its hazards and the required preconditions', () => {
    for (const text of ['NOT A ROLLBACK', 'CAN reach the live Asana', 'Stop all testing', 'ASANA_LIVE_INCIDENTS_ENABLED', 'NOT retried and NOT reported']) {
      expect(em).toContain(text)
    }
  })
})
