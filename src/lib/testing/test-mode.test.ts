import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { activeSessionFrom, canManageTesting, testingError, testSessionEndLabel, TEST_SESSION_MINUTES, validTestReason } from './test-mode'
import { readFlagTestClassification } from './flag-test-classification'

describe('who may manage testing', () => {
  it.each(['company_admin', 'gm', 'ops_manager'])('%s may', (r) => expect(canManageTesting(r)).toBe(true))
  it.each(['inspector', 'field_lead', 'maintenance_coordinator', 'maintenance_tech', '', null, undefined, 'COMPANY_ADMIN'])('%s may not', (r) => expect(canManageTesting(r)).toBe(false))
})

describe('session helpers', () => {
  const now = Date.parse('2026-11-23T10:00:00Z')
  const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
  const row = (o: Record<string, unknown> = {}) => ({ started_at: '2026-11-23T09:30:00Z', ends_at: '2026-11-23T10:30:00Z', ended_at: null, reason: 'Unit 13 run', property_id: PROP, property: { name: 'Unit 13' }, ...o })
  it('active session is found, with its apartment', () => expect(activeSessionFrom([row()], now)).toEqual({ endsAt: '2026-11-23T10:30:00Z', reason: 'Unit 13 run', propertyId: PROP, propertyName: 'Unit 13' }))
  it('embedded apartment as an array, or missing name, is handled', () => {
    expect(activeSessionFrom([row({ property: [{ name: 'Unit 13' }] })], now)?.propertyName).toBe('Unit 13')
    expect(activeSessionFrom([row({ property: null })], now)?.propertyName).toBe('the selected apartment')
  })
  it.each([
    ['expired', row({ ends_at: '2026-11-23T09:59:59Z' })],
    ['ended', row({ ended_at: '2026-11-23T09:45:00Z' })],
    ['not started', row({ started_at: '2026-11-23T10:01:00Z' })],
    ['malformed', row({ ends_at: 'soon' })],
    ['no apartment', row({ property_id: null })],
  ])('%s session is ignored', (_l, r) => expect(activeSessionFrom([r], now)).toBeNull())
  it('no rows / null', () => { expect(activeSessionFrom([], now)).toBeNull(); expect(activeSessionFrom(null, now)).toBeNull() })
  it('end label is South Africa time', () => expect(testSessionEndLabel('2026-11-23T10:30:00Z')).toBe('12:30'))
  it('bad end label is safe', () => expect(testSessionEndLabel('x')).toBe('later today'))
  it('durations stay within the database limit (5–240)', () => {
    for (const m of TEST_SESSION_MINUTES) { expect(m).toBeGreaterThanOrEqual(5); expect(m).toBeLessThanOrEqual(240) }
  })
  it.each([['abc', true], ['  Unit 13 test  ', true], ['ab', false], ['ok', false], ['   ', false], ['x'.repeat(201), false], [42, false], [null, false]])('reason %s -> %s', (v, ok) => expect(validTestReason(v)).toBe(ok))
})

describe('error messages never leak database text', () => {
  it.each([['PGRST202'], ['42P01'], ['42703'], ['42883']])('%s -> not switched on yet', (code) => expect(testingError({ code })).toMatch(/not switched on yet/))
  it('42501 -> managers only', () => expect(testingError({ code: '42501' })).toMatch(/Only operations managers/))
  it('22023 -> reason', () => expect(testingError({ code: '22023' })).toMatch(/reason/))
  it('55000 -> end the other apartment first', () => expect(testingError({ code: '55000' })).toMatch(/another apartment/))
  it('anything else -> generic', () => {
    const msg = testingError({ code: 'XX000', message: 'relation "public.secret" …' } as { code: string })
    expect(msg).toBe('Could not save. Check your connection and try again.')
    expect(testingError(null)).toBe(msg)
  })
})

describe('readFlagTestClassification', () => {
  const client = (r: unknown, cols: string[] = []) => ({
    from: () => { const q = { select: (c: string) => (cols.push(c), q), eq: () => q, maybeSingle: async () => { if (r === 'throw') throw new Error('x'); return r } }; return q },
  }) as unknown as SupabaseClient
  it('test / normal only from an explicit boolean', async () => {
    const cols: string[] = []
    expect(await readFlagTestClassification(client({ data: { is_test: true }, error: null }, cols), 'f')).toBe('test')
    expect(cols).toEqual(['is_test'])
    expect(await readFlagTestClassification(client({ data: { is_test: false }, error: null }), 'f')).toBe('normal')
  })
  it('anything uncertain is unknown (never guessed)', async () => {
    expect(await readFlagTestClassification(client({ data: { is_test: 'true' }, error: null }), 'f')).toBe('unknown')
    expect(await readFlagTestClassification(client({ data: null, error: null }), 'f')).toBe('unknown')
    expect(await readFlagTestClassification(client({ data: null, error: { code: 'XX000' } }), 'f')).toBe('unknown')
    expect(await readFlagTestClassification(client({ data: null, error: { code: '57014' } }), 'f')).toBe('unknown')
    expect(await readFlagTestClassification(client('throw'), 'f')).toBe('unknown')
  })
  it('column missing (migration not applied): normal, the pre-migration behaviour', async () => {
    expect(await readFlagTestClassification(client({ data: null, error: { code: '42703' } }), 'f')).toBe('normal')
  })
})
