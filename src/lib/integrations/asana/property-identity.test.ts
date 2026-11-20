import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPropertyIdentity, propertyIdentityParts, validatePropertyIdentity } from './property-identity'

const property = { id: 'p', company_id: 'a', name: 'Unit 91', address: 'Ballito Village', unit_reference: '91', deleted_at: null }
const row = { company_id: 'a', property_id: 'p', estate_key: 'ballito_village', unit_number: '91', investor_task_gid: '123', unit_option_gid: '456', properties: property }

describe('estate and unit identity', () => {
  it('keeps the same physical number in the two estates separate', () => {
    expect(propertyIdentityParts(property)).toEqual({ estate: 'ballito_village', unit: '91' })
    expect(propertyIdentityParts({ ...property, address: 'Ballito Life' })).toEqual({ estate: 'ballito_life', unit: '91' })
  })
  it.each(['BallitoLife', 'BALLITO LIFE', 'Ballito-Life Estate'])('recognizes %s', address => {
    expect(propertyIdentityParts({ ...property, address })?.estate).toBe('ballito_life')
  })
  it.each([
    { ...property, address: 'Ballito' },
    { ...property, address: 'Ballito Life and Ballito Village' },
    { ...property, unit_reference: '92' },
    { ...property, unit_reference: '91 / 92' },
    { ...property, unit_reference: '91B' },
    { ...property, name: 'Test property', unit_reference: null },
  ])('refuses missing or contradictory identity %#', p => expect(propertyIdentityParts(p)).toBeNull())
  it('normalizes leading zeros and uses an explicit reference when the name is descriptive', () => {
    expect(propertyIdentityParts({ ...property, name: 'Beach apartment', unit_reference: 'Apt 0091' })?.unit).toBe('91')
  })
  it.each(['BL 13', 'Bl13', 'BL-013'])('accepts the existing Life unit-reference format %s', unit_reference => {
    expect(propertyIdentityParts({ name: '13', address: 'Ballito Life', unit_reference })).toEqual({ estate: 'ballito_life', unit: '13' })
  })
  it('requires an estate prefix to agree with the full estate, in both names and references', () => {
    expect(propertyIdentityParts({ ...property, unit_reference: 'BL91' })).toBeNull()
    expect(propertyIdentityParts({ ...property, name: 'BL91' })).toBeNull()
    expect(propertyIdentityParts({ ...property, unit_reference: 'BV91' })).toEqual({ estate: 'ballito_village', unit: '91' })
  })
})

describe('verified mapping safety', () => {
  it('accepts the exact current property', () => {
    expect(validatePropertyIdentity(row, 'a', 'p')).toEqual({ kind: 'mapped', unitOptionGid: '456', unitNumber: '91' })
  })
  it.each([
    { ...row, company_id: 'other' }, { ...row, property_id: 'other' },
    { ...row, properties: { ...property, company_id: 'other' } },
    { ...row, properties: { ...property, id: 'other' } },
    { ...row, properties: { ...property, deleted_at: '2026-11-20' } },
    { ...row, properties: { ...property, address: 'Ballito Life' } },
    { ...row, properties: { ...property, name: 'Unit 92', unit_reference: '92' } },
    { ...row, estate_key: 'ballito_life' }, { ...row, unit_number: '92' },
    { ...row, unit_option_gid: '' }, { ...row, unit_option_gid: 'forged' },
    { ...row, investor_task_gid: 'forged' }, { ...row, properties: null },
    { ...row, properties: [property] }, { ...row, properties: { ...property, name: null } },
  ])('rejects a foreign, removed, stale or malformed mapping %#', invalid => {
    expect(validatePropertyIdentity(invalid, 'a', 'p')).toEqual({ kind: 'invalid' })
  })
  it('keeps valid identity after unrelated changes to the property description', () => {
    expect(validatePropertyIdentity({ ...row, properties: { ...property, name: 'Beach apartment', notes: 'New notes', bedrooms: 3 } }, 'a', 'p').kind).toBe('mapped')
  })
})

describe('mapping reads', () => {
  function db(result: unknown, reject = false) {
    const eq = vi.fn(), select = vi.fn()
    const q = { select, eq, maybeSingle: async () => { if (reject) throw new Error('private connection details'); return result } }
    eq.mockReturnValue(q); select.mockReturnValue(q)
    return { eq, select, client: { from: vi.fn(() => q) } as unknown as SupabaseClient }
  }
  it('scopes the lookup by both company and immutable property ID and reads current metadata', async () => {
    const d = db({ data: row, error: null })
    expect((await loadPropertyIdentity(d.client, 'a', 'p')).kind).toBe('mapped')
    expect(d.eq.mock.calls).toEqual([['company_id', 'a'], ['property_id', 'p']])
    expect(d.select.mock.calls[0][0]).toContain('properties!inner')
  })
  it('does not infer a unit from a missing mapping (including test properties)', async () => {
    expect(await loadPropertyIdentity(db({ data: null, error: null }).client, 'a', 'p')).toEqual({ kind: 'unmapped' })
  })
  it.each(['42P01', 'PGRST205', '42501', 'XX000'])('handles %s without blocking task creation or exposing the error', async code => {
    expect(await loadPropertyIdentity(db({ data: null, error: { code, message: 'private details' } }).client, 'a', 'p')).toEqual({ kind: 'unavailable' })
  })
  it('handles a network exception without exposing it', async () => {
    expect(await loadPropertyIdentity(db(null, true).client, 'a', 'p')).toEqual({ kind: 'unavailable' })
  })
})
