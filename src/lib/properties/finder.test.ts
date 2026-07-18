import { describe, it, expect } from 'vitest'
import {
  classifyEstate,
  naturalCompare,
  compareProperties,
  propertyMatchesQuery,
  filterProperties,
  estateCounts,
  ESTATE_LABEL,
  type FinderProperty,
} from '@/lib/properties/finder'

function prop(overrides: Partial<FinderProperty> = {}): FinderProperty {
  return {
    id: 'id-' + (overrides.name ?? 'x'),
    name: 'Unit',
    address: null,
    unit_reference: null,
    status: 'idle',
    bedrooms: null,
    ...overrides,
  }
}

describe('classifyEstate', () => {
  it('matches "Ballito Life" and its spacing/case variants', () => {
    expect(classifyEstate(prop({ name: 'Ballito Life 12' }))).toBe('ballito_life')
    expect(classifyEstate(prop({ name: 'BallitoLife 12' }))).toBe('ballito_life')
    expect(classifyEstate(prop({ name: 'ballito life' }))).toBe('ballito_life')
    expect(classifyEstate(prop({ name: 'BALLITO  LIFE — 3' }))).toBe('ballito_life')
    expect(classifyEstate(prop({ name: 'ballito-life' }))).toBe('ballito_life')
  })

  it('matches "Ballito Village" and its variants (not confused with Life)', () => {
    expect(classifyEstate(prop({ name: 'Ballito Village 4' }))).toBe('ballito_village')
    expect(classifyEstate(prop({ name: 'BallitoVillage' }))).toBe('ballito_village')
    expect(classifyEstate(prop({ name: 'ballito village unit 9' }))).toBe('ballito_village')
  })

  it('reads the estate from unit_reference or address, not just name', () => {
    expect(classifyEstate(prop({ name: '95', unit_reference: 'Ballito Life' }))).toBe('ballito_life')
    expect(
      classifyEstate(prop({ name: 'Unit 2', address: '10 Palm Rd, Ballito Village' })),
    ).toBe('ballito_village')
  })

  it('leaves unmatched / test properties as "other" (never hidden)', () => {
    expect(classifyEstate(prop({ name: 'Test 1' }))).toBe('other')
    expect(classifyEstate(prop({ name: 'Ballito' }))).toBe('other') // bare "Ballito" is not enough
    expect(classifyEstate(prop({ name: 'Seaside 3', address: 'Umhlanga' }))).toBe('other')
  })
})

describe('naturalCompare', () => {
  it('orders numeric strings by value, not lexically', () => {
    const sorted = ['10', '2', '103', '95', '102'].sort(naturalCompare)
    expect(sorted).toEqual(['2', '10', '95', '102', '103'])
  })

  it('orders "Unit Nr - N" naturally', () => {
    const sorted = ['Unit Nr - 10', 'Unit Nr - 2', 'Unit Nr - 95', 'Unit Nr - 103'].sort(
      naturalCompare,
    )
    expect(sorted).toEqual(['Unit Nr - 2', 'Unit Nr - 10', 'Unit Nr - 95', 'Unit Nr - 103'])
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(naturalCompare('test 1', 'Test 1')).toBe(0)
    expect(naturalCompare('Test  2', 'Test 10')).toBeLessThan(0)
  })

  it('is deterministic and total (a<b implies b>a)', () => {
    expect(naturalCompare('95', 'Test 1')).toBeLessThan(0) // number before letters
    expect(naturalCompare('Test 1', '95')).toBeGreaterThan(0)
  })
})

describe('compareProperties', () => {
  it('sorts a mixed property list into natural order by name', () => {
    const list = [
      prop({ id: 'a', name: 'Unit Nr - 102' }),
      prop({ id: 'b', name: 'Unit Nr - 2' }),
      prop({ id: 'c', name: 'Unit Nr - 10' }),
      prop({ id: 'd', name: 'Unit Nr - 95' }),
      prop({ id: 'e', name: 'Unit Nr - 103' }),
    ]
    expect([...list].sort(compareProperties).map((p) => p.name)).toEqual([
      'Unit Nr - 2',
      'Unit Nr - 10',
      'Unit Nr - 95',
      'Unit Nr - 102',
      'Unit Nr - 103',
    ])
  })

  it('breaks name ties by unit_reference then id (stable)', () => {
    const a = prop({ id: 'id-2', name: 'Cottage', unit_reference: 'B' })
    const b = prop({ id: 'id-1', name: 'Cottage', unit_reference: 'A' })
    expect(compareProperties(a, b)).toBeGreaterThan(0) // A before B
  })
})

describe('propertyMatchesQuery', () => {
  const p = prop({
    name: 'Unit Nr - 95',
    unit_reference: 'BL-95',
    address: '10 Dolphin Cres, Ballito',
  })

  it('empty / whitespace query matches everything', () => {
    expect(propertyMatchesQuery(p, '')).toBe(true)
    expect(propertyMatchesQuery(p, '   ')).toBe(true)
  })

  it('is case-insensitive and trimmed across name, unit, address', () => {
    expect(propertyMatchesQuery(p, '  95 ')).toBe(true)
    expect(propertyMatchesQuery(p, 'dolphin')).toBe(true)
    expect(propertyMatchesQuery(p, 'bl-95')).toBe(true)
    expect(propertyMatchesQuery(p, 'zzz')).toBe(false)
  })

  it('matches on the derived estate label', () => {
    const life = prop({ name: 'BallitoLife 7' })
    expect(propertyMatchesQuery(life, 'ballito life')).toBe(true)
  })
})

describe('filterProperties (estate + search compose)', () => {
  const properties: FinderProperty[] = [
    prop({ id: '1', name: 'Ballito Life 10' }),
    prop({ id: '2', name: 'Ballito Life 2' }),
    prop({ id: '5', name: 'BallitoLife 3' }), // spelling variant — still Ballito Life
    prop({ id: '3', name: 'Ballito Village 95' }),
    prop({ id: '4', name: 'Test 1' }),
  ]

  it('estate filter keeps only that estate (incl. spelling variants), naturally ordered', () => {
    const out = filterProperties(properties, { estate: 'ballito_life', query: '' })
    // "Ballito Life 2" < "Ballito Life 10" numerically; the "BallitoLife"
    // spelling variant is still included (grouped by its distinct spelling).
    expect(out.map((p) => p.name)).toEqual([
      'Ballito Life 2',
      'Ballito Life 10',
      'BallitoLife 3',
    ])
  })

  it('estate + query work together', () => {
    const out = filterProperties(properties, { estate: 'ballito_life', query: '10' })
    expect(out.map((p) => p.name)).toEqual(['Ballito Life 10'])
  })

  it('"all" + query searches every estate incl. unmatched', () => {
    const out = filterProperties(properties, { estate: 'all', query: 'test' })
    expect(out.map((p) => p.name)).toEqual(['Test 1'])
  })

  it('returns an empty list for a no-results query (drives the empty state)', () => {
    expect(filterProperties(properties, { estate: 'all', query: 'nope' })).toEqual([])
  })

  it('does not mutate the input array', () => {
    const before = properties.map((p) => p.id)
    filterProperties(properties, { estate: 'all', query: '' })
    expect(properties.map((p) => p.id)).toEqual(before)
  })
})

describe('estateCounts', () => {
  it('counts each estate and the total, incl. an Other bucket', () => {
    const counts = estateCounts([
      prop({ name: 'Ballito Life 1' }),
      prop({ name: 'BallitoLife 2' }),
      prop({ name: 'Ballito Village 3' }),
      prop({ name: 'Test 1' }),
    ])
    expect(counts).toEqual({ all: 4, ballito_life: 2, ballito_village: 1, other: 1 })
  })

  it('labels are stable', () => {
    expect(ESTATE_LABEL.ballito_life).toBe('Ballito Life')
    expect(ESTATE_LABEL.ballito_village).toBe('Ballito Village')
  })
})
