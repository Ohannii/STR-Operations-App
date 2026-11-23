import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assessHandoffHealth, parseHandoffHealth, type HandoffHealthRaw } from './handoff-health'
import { loadHandoffHealth } from './load-handoff-health'

const NOW = Date.parse('2026-11-23T12:00:00Z')
const F = '96487471-8c6e-48bc-828e-26255ad5277d'
const P = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const raw = (o: Partial<HandoffHealthRaw> = {}): HandoffHealthRaw => ({
  asana_enabled: true, missing: 0, missing_beyond_retry: 0, stopped: 0, stuck: 0, oldest_problem_at: null, items: [],
  last_check_at: '2026-11-23T11:58:00Z', last_check_ok_at: '2026-11-23T11:58:00Z', last_check_ok: true, ...o,
})

describe('what a manager sees', () => {
  it('healthy: nothing to do (dashboard shows nothing)', () => {
    const h = assessHandoffHealth(raw(), NOW)
    expect(h).toMatchObject({ level: 'ok', worker: 'ok', problems: 0, actions: [] })
  })
  it('empty queue with a recent successful check is NOT confused with a broken worker', () => {
    expect(assessHandoffHealth(raw(), NOW).level).toBe('ok')
    const stale = assessHandoffHealth(raw({ last_check_at: '2026-11-23T11:40:00Z', last_check_ok_at: '2026-11-23T11:40:00Z' }), NOW)
    expect(stale).toMatchObject({ level: 'attention', worker: 'stale', headline: 'Automatic sending to Asana is not running' })
    expect(stale.actions.join(' ')).toContain('/api/integrations/asana/worker')
    const failing = assessHandoffHealth(raw({ last_check_ok: false }), NOW)
    expect(failing).toMatchObject({ level: 'attention', worker: 'failing' })
  })
  it('ordinary 2-minute latency is never an incident (14 min since check is still fine)', () => {
    expect(assessHandoffHealth(raw({ last_check_at: '2026-11-23T11:46:00Z' }), NOW).level).toBe('ok')
  })
  it('worker never reported and nothing waiting: neutral, not an alarm', () => {
    expect(assessHandoffHealth(raw({ last_check_at: null, last_check_ok_at: null, last_check_ok: null }), NOW)).toMatchObject({ level: 'ok', worker: 'never_ran' })
  })
  it('problems: headline, details, items linking to the issue, and recovery guidance', () => {
    const h = assessHandoffHealth(raw({
      missing: 2, missing_beyond_retry: 1, stopped: 1, stuck: 1, oldest_problem_at: '2026-11-08T00:00:00Z',
      items: [
        { flag_id: F, property_id: P, property_name: 'Unit 13', raised_at: '2026-11-08T00:00:00Z', problem: 'missing' },
        { flag_id: F, property_id: P, property_name: 'Unit 14', raised_at: '2026-11-23T11:00:00Z', problem: 'stopped' },
      ],
    }), NOW)
    expect(h.level).toBe('attention')
    expect(h.headline).toBe('4 issues have not reached Asana')
    expect(h.details.join(' ')).toContain('1 older than 14 days, no longer retried automatically')
    expect(h.items[0]).toEqual({ href: `/properties/${P}/flags/${F}`, apartment: 'Unit 13', raisedAt: '2026-11-08T00:00:00Z', label: 'Not sent, no longer retried automatically' })
    expect(h.items[1].label).toBe('Sending stopped')
    expect(h.actions.join(' ')).toMatch(/create the Asana task by hand/)
    expect(h.actions.join(' ')).toMatch(/keeps retrying/)
  })
  it('Asana switched off for the company: no alarm', () => {
    expect(assessHandoffHealth(raw({ asana_enabled: false, missing: 3 }), NOW).level).toBe('off')
  })
})

describe('parsing the database answer', () => {
  it('rejects unusable answers', () => {
    for (const v of [null, [], 'x', {}, { asana_enabled: 'yes' }]) expect(parseHandoffHealth(v)).toBeNull()
  })
  it('drops malformed items, caps at 10, ignores negative counts', () => {
    const items = Array.from({ length: 12 }, () => ({ flag_id: F, property_id: P, property_name: 'U', raised_at: '2026-11-23T11:00:00Z', problem: 'missing' }))
    const r = parseHandoffHealth({ asana_enabled: true, missing: -3, items: [...items, { flag_id: 'x' }, { ...items[0], problem: 'weird' }] })!
    expect(r.items).toHaveLength(10)
    expect(r.missing).toBe(0)
  })
  it('carries no free text from the issue (no description field survives parsing)', () => {
    const r = parseHandoffHealth({ asana_enabled: true, items: [{ flag_id: F, property_id: P, property_name: 'U', raised_at: '2026-11-23T11:00:00Z', problem: 'missing', description: 'guest Jane' }] })!
    expect(JSON.stringify(r)).not.toContain('Jane')
  })
})

describe('loadHandoffHealth', () => {
  const client = (r: unknown) => ({ rpc: async (fn: string, args: unknown) => { if (r === 'throw') throw new Error('x'); return { ...(r as object), fn, args } } }) as unknown as SupabaseClient
  it('asks the database for THIS company only', async () => {
    let seen: unknown
    const c = { rpc: async (fn: string, args: unknown) => { seen = [fn, args]; return { data: raw(), error: null } } } as unknown as SupabaseClient
    expect(await loadHandoffHealth(c, 'co-1')).toMatchObject({ level: expect.any(String) })
    expect(seen).toEqual(['asana_handoff_health', { p_company_id: 'co-1' }])
  })
  it('missing function (before migration), refusal, odd data or a throw -> unavailable, never an exception', async () => {
    expect(await loadHandoffHealth(client({ data: null, error: { code: 'PGRST202' } }), 'c')).toBe('unavailable')
    expect(await loadHandoffHealth(client({ data: null, error: { code: '42501' } }), 'c')).toBe('unavailable')
    expect(await loadHandoffHealth(client({ data: { nope: 1 }, error: null }), 'c')).toBe('unavailable')
    expect(await loadHandoffHealth(client('throw'), 'c')).toBe('unavailable')
  })
})
