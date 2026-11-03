import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATEGORY_FIELD_MAP,
  desiredFieldValuesForFlag,
} from '@/lib/integrations/asana/field-mapping'

/** Every current + legacy flag_categories key the app knows (lib/ui/flag-category). */
const ALL_KEYS = [
  'condition_note',
  'cleaning_issue',
  'maintenance_issue',
  'inventory_missing',
  'inventory_damaged',
  'guest_damage',
  'owner_chargeable',
  'company_responsibility',
  'safety_urgent',
  'follow_up_required',
  'no_action_record',
]

describe('desiredFieldValuesForFlag — the approved mapping, exactly', () => {
  it.each([
    ['maintenance_issue', { category: 'maintenance' }],
    ['inventory_missing', { category: 'inventory', inventoryIncidentType: 'missing_item' }],
    ['inventory_damaged', { category: 'inventory', inventoryIncidentType: 'physical_damage' }],
  ])('%s maps', (key, expected) => {
    const r = desiredFieldValuesForFlag({ categoryKey: key, durableEvidence: false })
    expect(r.desired).toEqual(expected)
    expect(r.warnings).toEqual([])
  })

  it.each([
    'cleaning_issue',
    'safety_urgent',
    'condition_note',
    'guest_damage',
    'owner_chargeable',
    'company_responsibility',
    'follow_up_required',
    'no_action_record',
    'linen', // not an app category; never inferred
    'Maintenance_Issue', // case-sensitive: no loose match
    ' maintenance_issue', // no trimming into a match
    'constructor', // no prototype keys
    '__proto__',
  ])('%s -> NO Category and NO incident type (unmapped_value warning)', (key) => {
    const r = desiredFieldValuesForFlag({ categoryKey: key, durableEvidence: false })
    expect(r.desired).toEqual({})
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'unmapped_value', field: 'category' })])
  })

  it.each([null, undefined, '', '   '])('%s -> omitted with empty_value', (key) => {
    const r = desiredFieldValuesForFlag({ categoryKey: key as string | null | undefined, durableEvidence: false })
    expect(r.desired).toEqual({})
    expect(r.warnings[0]).toMatchObject({ code: 'empty_value', field: 'category' })
  })

  it('exactly three keys map; every other known key is omitted', () => {
    expect(Object.keys(CATEGORY_FIELD_MAP).sort()).toEqual(['inventory_damaged', 'inventory_missing', 'maintenance_issue'])
    const mapped = ALL_KEYS.filter((k) => desiredFieldValuesForFlag({ categoryKey: k, durableEvidence: false }).desired.category)
    expect(mapped.sort()).toEqual(['inventory_damaged', 'inventory_missing', 'maintenance_issue'])
  })

  it('an incident type is only ever produced with Category = Inventory', () => {
    for (const k of ALL_KEYS) {
      const d = desiredFieldValuesForFlag({ categoryKey: k, durableEvidence: true }).desired
      if (d.inventoryIncidentType) expect(d.category).toBe('inventory')
      expect(d.linenIncidentType).toBeUndefined()
    }
  })

  it('Evidence: true -> yes; false -> omitted; null (query failed) -> omitted + source_unavailable', () => {
    expect(desiredFieldValuesForFlag({ categoryKey: 'maintenance_issue', durableEvidence: true }).desired.evidenceReceived).toBe('yes')
    expect(desiredFieldValuesForFlag({ categoryKey: 'maintenance_issue', durableEvidence: false }).desired).not.toHaveProperty('evidenceReceived')
    const failed = desiredFieldValuesForFlag({ categoryKey: 'maintenance_issue', durableEvidence: null })
    expect(failed.desired).not.toHaveProperty('evidenceReceived')
    expect(failed.warnings).toEqual([expect.objectContaining({ code: 'source_unavailable', field: 'evidenceReceived' })])
  })

  it('NEVER produces Unit #, Unit Number, Linen type, Accountable Party or Evidence "No"', () => {
    for (const k of [...ALL_KEYS, null, 'x']) {
      for (const ev of [true, false, null]) {
        const d = desiredFieldValuesForFlag({ categoryKey: k, durableEvidence: ev }).desired
        expect(d).not.toHaveProperty('unitOptionGid')
        expect(d).not.toHaveProperty('unitNumber')
        expect(d).not.toHaveProperty('linenIncidentType')
        expect(d).not.toHaveProperty('accountableParty')
        expect([undefined, 'yes']).toContain(d.evidenceReceived)
      }
    }
  })

  it('warnings never contain the value', () => {
    const r = desiredFieldValuesForFlag({ categoryKey: 'cleaning_issue', durableEvidence: null })
    expect(JSON.stringify(r.warnings)).not.toContain('cleaning_issue')
  })

  it('source: pure, structured facts only — no I/O, names, notes or free text', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/integrations/asana/field-mapping.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/fetch\(|supabase|\.from\(|\.name\b|notes|description|caption|unit_reference|propertyName/)
    expect(src).not.toMatch(/unitOptionGid|unitNumber|linenIncidentType|accountableParty|'no'/)
  })
})
