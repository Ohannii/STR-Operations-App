import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  BETA_FIELD_CONFIG,
  EXPECTED_FIELD_TYPES,
  LIVE_INCIDENTS_FIELD_REFERENCE,
  LIVE_INCIDENTS_PROJECT_GID,
  configForWrite,
  configTypeErrors,
  fieldConfigForProject,
  isWritableFieldConfig,
  writableFieldConfig,
  type ProjectFieldConfig,
  type WritableFieldConfig,
} from '@/lib/integrations/asana/field-config'
import {
  logFieldWarnings,
  parseProjectFieldMetadata,
  resolveCustomFields,
  validateFieldConfig,
  validateWritableFieldConfig,
  type DesiredFieldValues,
  type FieldValidation,
  type WritableFieldValidation,
} from '@/lib/integrations/asana/field-validation'
import { inspectFieldConfig, loadWritableFieldValidation } from '@/lib/integrations/asana/field-schema'
import { ASANA_TEST_PROJECT_GID, DisallowedAsanaProjectError } from '@/lib/integrations/asana/config'
import {
  FIELD_SETTINGS_MAX_PAGES,
  getProjectCustomFieldSettings,
} from '@/lib/integrations/asana/client'

/**
 * Phase 1 (hardened) — custom-field configuration, paginated read-only
 * schema loading and validation. Everything is matched by GID; nothing is
 * guessed; nothing is written; the live project can only be inspected.
 */

type Field = {
  gid: string
  name: string
  resource_subtype: string
  enum_options?: Array<{ gid: string; name: string; enabled: boolean }>
}

/** Live-shaped field schema (GIDs from the 29 Oct read-only audit). */
const LIVE_FIELDS: Field[] = [
  { gid: '1213116492387386', name: 'Unit #', resource_subtype: 'multi_enum', enum_options: [
    { gid: '1214009753087420', name: 'TF01 - 50 BL', enabled: true },
    { gid: '1213132578818915', name: 'KRG01 - ', enabled: false },
  ] },
  { gid: '1210401516520213', name: 'Unit Number', resource_subtype: 'text' },
  { gid: '1211490712226251', name: 'Category', resource_subtype: 'enum', enum_options: [
    { gid: '1211490712226252', name: 'Linen', enabled: true },
    { gid: '1211490712226253', name: 'Inventory', enabled: true },
    { gid: '1219255393409321', name: 'Maintenance ', enabled: true },
  ] },
  { gid: '1211490712226261', name: 'INVENTORY Incident type', resource_subtype: 'enum', enum_options: [
    { gid: '1211490712226262', name: 'Physical Damage', enabled: true },
    { gid: '1211490712226263', name: 'Missing Item', enabled: true },
  ] },
  { gid: '1211490712226255', name: 'Linen Incident type', resource_subtype: 'enum', enum_options: [
    { gid: '1211490712226256', name: 'Stain', enabled: true },
    { gid: '1211490712226257', name: 'Torn/Irreparable', enabled: true },
    { gid: '1211490712226258', name: 'Missing', enabled: true },
  ] },
  { gid: '1211426871181279', name: 'Evidence Received', resource_subtype: 'enum', enum_options: [
    { gid: '1211426871181280', name: 'Yes', enabled: true },
    { gid: '1211426871181281', name: 'No', enabled: true },
  ] },
  { gid: '1211505770478165', name: 'Accountable Party', resource_subtype: 'multi_enum', enum_options: [
    { gid: '1211505775360953', name: 'Guest', enabled: true },
    { gid: '1211505770478166', name: 'Drop-Inn', enabled: true },
    { gid: '1213006046000163', name: 'Investor', enabled: true },
    { gid: '1211505775360954', name: 'Undetermined', enabled: true },
  ] },
  // On the live project but deliberately NOT configured (manager triage).
  { gid: '1211426204541396', name: 'Severity', resource_subtype: 'enum', enum_options: [
    { gid: '1211426204541397', name: 'Minor', enabled: true },
  ] },
]

/** Metadata for `projectGid`, each setting naming its parent project. */
function metadata(
  projectGid: string,
  o: { drop?: string[]; retype?: Record<string, string>; disable?: string[]; rename?: Record<string, string> } = {},
) {
  const disable = new Set(o.disable ?? [])
  return {
    gid: projectGid,
    custom_field_settings: LIVE_FIELDS.filter((f) => !(o.drop ?? []).includes(f.gid)).map((f) => ({
      project: { gid: projectGid },
      custom_field: {
        ...f,
        name: o.rename?.[f.gid] ?? f.name,
        resource_subtype: o.retype?.[f.gid] ?? f.resource_subtype,
        ...(f.enum_options
          ? { enum_options: f.enum_options.map((x) => ({ ...x, enabled: x.enabled && !disable.has(x.gid) })) }
          : {}),
      },
    })),
  }
}
const liveMetadata = (o?: Parameters<typeof metadata>[1]) => metadata(LIVE_INCIDENTS_PROJECT_GID, o)

/**
 * A WRITABLE BETA config mirroring the live field set (what BETA will look
 * like once the admin mirrors the fields). Minted through the allowlist.
 */
const BETA_MIRROR: WritableFieldConfig = writableFieldConfig({
  ...LIVE_INCIDENTS_FIELD_REFERENCE,
  projectGid: ASANA_TEST_PROJECT_GID,
  label: 'BETA mirror (test)',
})
const writable = (o?: Parameters<typeof metadata>[1]): WritableFieldValidation =>
  validateWritableFieldConfig(BETA_MIRROR, metadata(ASANA_TEST_PROJECT_GID, o))

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// ----------------------------------------------------------------

describe('field configuration', () => {
  it('every declared field carries its expected Asana type (BETA and live)', () => {
    expect(configTypeErrors(BETA_FIELD_CONFIG)).toEqual([])
    expect(configTypeErrors(LIVE_INCIDENTS_FIELD_REFERENCE)).toEqual([])
  })

  it('triage-owned fields are NOT configured anywhere (Severity, Severity Status, Replacement Required, Month, costs)', () => {
    const triageGids = [
      '1211426204541396', // Severity
      '1211899401497849', // Severity Status
      '1214079196883375', // Replacement Required
      '1219298110836965', // Month
      '1211426204541403', // Actual Cost INCL VAT
      '1211426204541401', // Guest Cost Recovered
      '1214777661246087', // Owner Cost Recovery
      '1211505621570699', // Cost Collection Status
    ]
    for (const config of [BETA_FIELD_CONFIG, LIVE_INCIDENTS_FIELD_REFERENCE]) {
      const gids = Object.values(config.fields).map((f) => f?.gid)
      for (const g of triageGids) expect(gids).not.toContain(g)
    }
    expect(Object.keys(EXPECTED_FIELD_TYPES).sort()).toEqual([
      'accountableParty', 'category', 'evidenceReceived', 'inventoryIncidentType',
      'linenIncidentType', 'unit', 'unitNumber',
    ])
  })

  it('BETA declares only the two workspace-library fields until the admin mirrors the rest', () => {
    expect(BETA_FIELD_CONFIG.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    expect(Object.keys(BETA_FIELD_CONFIG.fields).sort()).toEqual(['unit', 'unitNumber'])
  })
})

describe('BETA WRITE BOUNDARY — live configuration can be inspected, never written', () => {
  it('writable configuration can only be minted for the pinned BETA project', () => {
    expect(isWritableFieldConfig(configForWrite(ASANA_TEST_PROJECT_GID))).toBe(true)
    expect(() => configForWrite(LIVE_INCIDENTS_PROJECT_GID)).toThrow(DisallowedAsanaProjectError)
    expect(() => writableFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE)).toThrow(DisallowedAsanaProjectError)
    expect(() => configForWrite('999')).toThrow(DisallowedAsanaProjectError)
    expect(isWritableFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE)).toBe(false)
    expect(isWritableFieldConfig(BETA_FIELD_CONFIG)).toBe(false) // plain config is inspection-only too
    expect(fieldConfigForProject(LIVE_INCIDENTS_PROJECT_GID)).toBe(LIVE_INCIDENTS_FIELD_REFERENCE)
  })

  it('a VALID live schema still cannot reach the write resolver (types + runtime)', () => {
    const liveValidation: FieldValidation = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, liveMetadata())
    expect(liveValidation.ok).toBe(true) // the live schema is perfectly valid...
    expect(() =>
      // @ts-expect-error -- an inspection-only validation is not a WritableFieldValidation
      resolveCustomFields({ category: 'inventory' }, liveValidation),
    ).toThrow(TypeError) // ...and is still refused
    expect(() =>
      // @ts-expect-error -- live reference config is not WritableFieldConfig
      validateWritableFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, liveMetadata()),
    ).toThrow(TypeError)
    // Even a forged brand is caught by the runtime allowlist re-check.
    const forged = { ...liveValidation, ...writable() , projectGid: LIVE_INCIDENTS_PROJECT_GID } as WritableFieldValidation
    expect(() => resolveCustomFields({ category: 'inventory' }, forged)).toThrow(DisallowedAsanaProjectError)
  })

  it('a writable validation of a cast live config is refused at runtime', () => {
    const cast = { ...LIVE_INCIDENTS_FIELD_REFERENCE } as unknown as WritableFieldConfig
    expect(() => validateWritableFieldConfig(cast, liveMetadata())).toThrow(TypeError)
  })
})

describe('source contracts — read-only, by GID, not wired into the worker', () => {
  const files = ['field-config.ts', 'field-validation.ts', 'field-schema.ts']

  it('never reads field/option NAMES and never makes a write call', () => {
    for (const f of files) {
      const src = code(read(`src/lib/integrations/asana/${f}`))
      expect(src).not.toMatch(/\.name\b/)
      expect(src).not.toMatch(/fetch\(|method:\s*'(POST|PUT|PATCH|DELETE)'/)
    }
  })

  it('the schema client call is a GET with limit=100 and every nested property requested', () => {
    const client = read('src/lib/integrations/asana/client.ts')
    const start = client.indexOf('export async function getProjectCustomFieldSettings(')
    const body = client.slice(start, client.indexOf('\nexport ', start + 10))
    expect(body).toContain("method: 'GET'")
    expect(body).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    expect(body).toContain("url.searchParams.set('limit', '100')")
    for (const p of [
      'parent.gid',
      'project.gid',
      'custom_field.gid',
      'custom_field.resource_subtype',
      'custom_field.enum_options.gid',
      'custom_field.enum_options.enabled',
    ]) {
      expect(body).toContain(`'${p}'`)
    }
  })

  it('NOT wired: no worker, route or app file imports the field modules; no custom_fields are sent', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = read(rel)
          if (/asana\/field-(config|validation|schema)/.test(src) && !rel.includes('/asana/field-')) {
            offenders.push(rel)
          }
        }
      }
    }
    walk('src')
    expect(offenders).toEqual([])
    const createTask = read('src/lib/integrations/asana/client.ts')
    expect(createTask).not.toContain('custom_fields')
    expect(read('src/lib/integrations/types.ts')).not.toMatch(/customFields|custom_fields/)
  })
})

describe('validateFieldConfig — read-only schema check by GID', () => {
  it('the live reference validates cleanly against the live schema', () => {
    const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, liveMetadata())
    expect(v.issues).toEqual([])
    expect(Object.keys(v.usable).sort()).toEqual(Object.keys(LIVE_INCIDENTS_FIELD_REFERENCE.fields).sort())
  })

  it('WRONG PROJECT: metadata for another project makes NOTHING usable', () => {
    const v = validateFieldConfig(BETA_FIELD_CONFIG, liveMetadata())
    expect(v.usable).toEqual({})
    expect(v.issues.map((i) => i.code)).toEqual(['project_mismatch'])
  })

  it('WHOLE-SCHEMA failures: wrong/missing project identity or an unreadable page make NOTHING usable', () => {
    const base = () => liveMetadata()
    const cases: Array<[string, (m: ReturnType<typeof base>) => unknown]> = [
      ['no parent project', (m) => (delete (m.custom_field_settings[0] as Record<string, unknown>).project, m)],
      ['`parent` is another project', (m) => {
        const s0 = m.custom_field_settings[0] as Record<string, unknown>
        delete s0.project
        s0.parent = { gid: '999' }
        return m
      }],
      ['`project` is another project', (m) => ((m.custom_field_settings[0].project.gid = '999'), m)],
      // Even on an UNCONFIGURED field (Severity), wrong identity poisons the whole read.
      ['unconfigured field from another project', (m) => ((m.custom_field_settings[7].project.gid = '999'), m)],
      ['settings not an array', (m) => ({ ...m, custom_field_settings: 'x' })],
      ['no project gid', (m) => ({ ...m, gid: '' })],
      ['not an object', () => 'x'],
      ['null', () => null],
    ]
    for (const [label, mutate] of cases) {
      const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, mutate(base()))
      expect(v.usable, label).toEqual({})
      expect(v.issues, label).toEqual([expect.objectContaining({ code: 'metadata_malformed' })])
    }
  })

  it('PER-FIELD defects in a CONFIGURED field invalidate ONLY that field', () => {
    const CATEGORY = 2 // index of Category in the fixture
    const cf = (m: ReturnType<typeof liveMetadata>) =>
      m.custom_field_settings[CATEGORY].custom_field as unknown as Record<string, unknown> & {
        enum_options: Array<Record<string, unknown>>
      }
    const cases: Array<[string, (m: ReturnType<typeof liveMetadata>) => void, string]> = [
      ['no resource_subtype', (m) => delete cf(m).resource_subtype, 'field_malformed'],
      ['enum without enum_options', (m) => delete (cf(m) as Record<string, unknown>).enum_options, 'field_malformed'],
      ['enum_options not an array', (m) => ((cf(m) as Record<string, unknown>).enum_options = 'x'), 'field_malformed'],
      ['option without enabled', (m) => delete cf(m).enum_options[0].enabled, 'field_malformed'],
      ['option without gid', (m) => delete cf(m).enum_options[0].gid, 'field_malformed'],
      ['option is null', (m) => (cf(m).enum_options[0] = null as never), 'field_malformed'],
      // No readable GID: cannot be attributed, so the configured field is simply missing.
      ['no field gid', (m) => delete cf(m).gid, 'field_missing'],
    ]
    for (const [label, mutate, code] of cases) {
      const m = liveMetadata()
      mutate(m)
      const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, m)
      expect(v.usable.category, label).toBeUndefined()
      expect(v.issues, label).toEqual([expect.objectContaining({ code, field: 'category' })])
      // Every OTHER configured field is still usable.
      expect(Object.keys(v.usable).sort(), label).toEqual(
        Object.keys(LIVE_INCIDENTS_FIELD_REFERENCE.fields).filter((k) => k !== 'category').sort(),
      )
    }
  })

  it('(1) a malformed CONFIGURED field leaves another configured field usable end to end', () => {
    const m = metadata(ASANA_TEST_PROJECT_GID)
    delete (m.custom_field_settings[2].custom_field as Record<string, unknown>).enum_options // Category
    const v = validateWritableFieldConfig(BETA_MIRROR, m)
    expect(v.issues).toEqual([expect.objectContaining({ code: 'field_malformed', field: 'category' })])
    const r = resolveCustomFields(
      { category: 'inventory', inventoryIncidentType: 'missing_item', evidenceReceived: 'yes', unitNumber: '50' },
      v,
    )
    // Evidence + Unit Number still go; Category is dropped and its subtype follows (dependency rule).
    expect(r.customFields).toEqual({
      '1211426871181279': '1211426871181280',
      '1210401516520213': '50',
    })
    expect(r.warnings.map((w) => [w.code, w.field])).toEqual([
      ['field_unusable', 'category'],
      ['dependency_unmet', 'inventoryIncidentType'],
    ])
  })

  it('(2) a malformed UNCONFIGURED Asana field never suppresses configured fields', () => {
    for (const mutate of [
      (f: Record<string, unknown>) => delete f.resource_subtype,
      (f: Record<string, unknown>) => delete f.enum_options,
      (f: Record<string, unknown>) => ((f.enum_options as Array<Record<string, unknown>>)[0].enabled = 'yes'),
      (f: Record<string, unknown>) => delete f.gid,
    ]) {
      const m = liveMetadata()
      mutate(m.custom_field_settings[7].custom_field as unknown as Record<string, unknown>) // Severity: not configured
      const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, m)
      expect(v.issues).toEqual([])
      expect(v.ok).toBe(true)
      expect(Object.keys(v.usable).sort()).toEqual(Object.keys(LIVE_INCIDENTS_FIELD_REFERENCE.fields).sort())
    }
  })

  it('(3) wrong-project metadata still invalidates EVERYTHING, even with perfect fields', () => {
    const v = validateWritableFieldConfig(BETA_MIRROR, liveMetadata()) // live schema, BETA config
    expect(v.usable).toEqual({})
    expect(v.issues).toEqual([expect.objectContaining({ code: 'project_mismatch' })])
    expect(resolveCustomFields({ category: 'inventory', evidenceReceived: 'yes' }, v).customFields).toEqual({})
  })

  it('MISSING FIELD: today’s BETA (no custom fields) reports both library fields missing', () => {
    const v = validateFieldConfig(BETA_FIELD_CONFIG, { gid: ASANA_TEST_PROJECT_GID, custom_field_settings: [] })
    expect(v.usable).toEqual({})
    expect(v.issues.map((i) => [i.code, i.field])).toEqual([
      ['field_missing', 'unit'],
      ['field_missing', 'unitNumber'],
    ])
  })

  it('a field with the SAME NAME but a different GID is still missing (never matched by name)', () => {
    const meta = liveMetadata({ drop: ['1211490712226251'] })
    meta.custom_field_settings.push({
      project: { gid: LIVE_INCIDENTS_PROJECT_GID },
      custom_field: {
        gid: '9999999999999999', name: 'Category', resource_subtype: 'enum',
        enum_options: [{ gid: '1211490712226253', name: 'Inventory', enabled: true }],
      },
    })
    const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, meta)
    expect(v.usable.category).toBeUndefined()
    expect(v.issues).toContainEqual(expect.objectContaining({ code: 'field_missing', field: 'category' }))
  })

  it('WRONG TYPE and CONFIG TYPE errors drop only that field', () => {
    const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, liveMetadata({ retype: { '1211505770478165': 'enum' } }))
    expect(v.usable.accountableParty).toBeUndefined()
    expect(v.usable.category).toBeDefined()
    expect(v.issues).toContainEqual(expect.objectContaining({ code: 'wrong_type', field: 'accountableParty' }))
    const broken: ProjectFieldConfig = {
      ...LIVE_INCIDENTS_FIELD_REFERENCE,
      fields: { ...LIVE_INCIDENTS_FIELD_REFERENCE.fields, category: { gid: '1211490712226251', type: 'multi_enum' } },
    }
    const v2 = validateFieldConfig(broken, liveMetadata())
    expect(v2.usable.category).toBeUndefined()
    expect(v2.issues).toContainEqual(expect.objectContaining({ code: 'config_type_mismatch', field: 'category' }))
  })

  it('DISABLED / MISSING OPTIONS withdraw only that option', () => {
    const v = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, liveMetadata({ disable: ['1211490712226252'] }))
    expect(v.issues).toContainEqual(expect.objectContaining({ code: 'option_disabled', field: 'category', option: 'linen' }))
    expect(v.usable.category?.options).toEqual({ inventory: '1211490712226253', maintenance: '1219255393409321' })
    const meta = liveMetadata()
    const ev = meta.custom_field_settings.find((s) => s.custom_field.gid === '1211426871181279')!
    ev.custom_field.enum_options = ev.custom_field.enum_options!.filter((o) => o.gid !== '1211426871181280')
    const v2 = validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, meta)
    expect(v2.issues).toContainEqual(expect.objectContaining({ code: 'option_missing', field: 'evidenceReceived', option: 'yes' }))
  })

  it('renaming fields/options in Asana changes NOTHING (GIDs are the identity)', () => {
    const v = validateFieldConfig(
      LIVE_INCIDENTS_FIELD_REFERENCE,
      liveMetadata({ rename: { '1211490712226251': 'Type', '1211426871181279': 'Photos?' } }),
    )
    expect(v.ok).toBe(true)
  })

  it('the current `parent` property is accepted in place of the deprecated `project`', () => {
    const m = liveMetadata()
    for (const s of m.custom_field_settings as Array<Record<string, unknown>>) {
      s.parent = s.project
      delete s.project
    }
    expect(validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, m).ok).toBe(true)
  })

  it('parseProjectFieldMetadata keeps only GIDs, subtypes and enabled flags', () => {
    const parsed = parseProjectFieldMetadata(liveMetadata())!
    expect(JSON.stringify(parsed)).not.toContain('Category')
  })
})

describe('resolveCustomFields — omit + warn, never guess', () => {
  it('builds the Asana payload by GID for deterministic values', () => {
    const r = resolveCustomFields(
      {
        unitOptionGid: '1214009753087420',
        unitNumber: ' 50 ',
        category: 'inventory',
        inventoryIncidentType: 'missing_item',
        evidenceReceived: 'yes',
        accountableParty: ['guest'],
      },
      writable(),
    )
    expect(r.warnings).toEqual([])
    expect(r.customFields).toEqual({
      '1213116492387386': ['1214009753087420'],
      '1210401516520213': '50',
      '1211490712226251': '1211490712226253',
      '1211490712226261': '1211490712226263',
      '1211426871181279': '1211426871181280',
      '1211505770478165': ['1211505775360953'],
    })
  })

  it('UNMAPPED VALUES are omitted with a warning; Accountable Party is all-or-nothing', () => {
    const r = resolveCustomFields(
      { category: 'cleaning' as never, accountableParty: ['guest', 'cleaning_team' as never] },
      writable(),
    )
    expect(r.customFields).toEqual({})
    expect(r.warnings.map((w) => [w.code, w.field])).toEqual([
      ['unmapped_value', 'category'],
      ['unmapped_value', 'accountableParty'],
    ])
  })

  it('a unit option GID that is unknown or DISABLED in the project is refused', () => {
    for (const gid of ['1213132578818915' /* disabled */, '42' /* unknown */]) {
      const r = resolveCustomFields({ unitOptionGid: gid }, writable())
      expect(r.customFields).toEqual({})
      expect(r.warnings[0]).toMatchObject({ code: 'unknown_option', field: 'unit' })
    }
  })

  it('MISSING CONFIG: today’s BETA yields a task WITHOUT custom fields, plus warnings', () => {
    const beta = validateWritableFieldConfig(configForWrite(ASANA_TEST_PROJECT_GID), {
      gid: ASANA_TEST_PROJECT_GID,
      custom_field_settings: [],
    })
    const r = resolveCustomFields({ unitOptionGid: '1214009753087420', category: 'inventory', evidenceReceived: 'yes' }, beta)
    expect(r.customFields).toEqual({})
    expect(r.warnings.map((w) => w.code)).toEqual(['field_unusable', 'field_unusable', 'field_unusable'])
  })

  it('blank text and empty selections are omitted, not sent', () => {
    const r = resolveCustomFields({ unitNumber: '   ', accountableParty: [] }, writable())
    expect(r.customFields).toEqual({})
    expect(r.warnings.map((w) => w.code)).toEqual(['empty_value', 'empty_value'])
  })
})

describe('DEPENDENCY COHERENCE — subtypes travel only with their own Category', () => {
  const CAT = '1211490712226251'
  const INV = '1211490712226261'
  const LIN = '1211490712226255'
  const EVID = '1211426871181279'

  it('Inventory subtype is emitted with Category = Inventory', () => {
    const r = resolveCustomFields({ category: 'inventory', inventoryIncidentType: 'physical_damage' }, writable())
    expect(r.customFields).toEqual({ [CAT]: '1211490712226253', [INV]: '1211490712226262' })
  })

  it('Linen subtype is emitted with Category = Linen', () => {
    const r = resolveCustomFields({ category: 'linen', linenIncidentType: 'stain' }, writable())
    expect(r.customFields).toEqual({ [CAT]: '1211490712226252', [LIN]: '1211490712226256' })
  })

  it('a subtype under the WRONG Category is omitted; the Category itself stays', () => {
    const r = resolveCustomFields(
      { category: 'maintenance', inventoryIncidentType: 'missing_item', linenIncidentType: 'stain' },
      writable(),
    )
    expect(r.customFields).toEqual({ [CAT]: '1219255393409321' })
    expect(r.warnings.map((w) => [w.code, w.field])).toEqual([
      ['dependency_unmet', 'inventoryIncidentType'],
      ['dependency_unmet', 'linenIncidentType'],
    ])
  })

  it('Category MISSING from the schema: both subtypes are omitted (Evidence stays)', () => {
    const r = resolveCustomFields(
      { category: 'inventory', inventoryIncidentType: 'missing_item', evidenceReceived: 'yes' },
      writable({ drop: [CAT] }),
    )
    expect(r.customFields).toEqual({ [EVID]: '1211426871181280' })
    expect(r.warnings.map((w) => w.code)).toEqual(['field_unusable', 'dependency_unmet'])
  })

  it('Category option DISABLED (invalid): its subtype is omitted', () => {
    const r = resolveCustomFields(
      { category: 'linen', linenIncidentType: 'torn_irreparable' },
      writable({ disable: ['1211490712226252'] }),
    )
    expect(r.customFields).toEqual({})
    expect(r.warnings.map((w) => w.code)).toEqual(['unmapped_value', 'dependency_unmet'])
  })

  it('Category UNMAPPED or not requested: subtypes are omitted', () => {
    expect(resolveCustomFields({ inventoryIncidentType: 'missing_item' }, writable()).customFields).toEqual({})
    expect(
      resolveCustomFields({ category: 'cleaning' as never, inventoryIncidentType: 'missing_item' }, writable())
        .customFields,
    ).toEqual({})
  })

  it('a MISSING subtype field does not drop the Category', () => {
    const r = resolveCustomFields(
      { category: 'inventory', inventoryIncidentType: 'missing_item' },
      writable({ drop: [INV] }),
    )
    expect(r.customFields).toEqual({ [CAT]: '1211490712226253' })
    expect(r.warnings.map((w) => [w.code, w.field])).toEqual([['field_unusable', 'inventoryIncidentType']])
  })
})

describe('PRIVACY — no values, guest data or tokens in warnings or logs', () => {
  const SECRET = 'Jane Guest #70523138 Hostaway'
  const desired: DesiredFieldValues = {
    unitOptionGid: SECRET,
    unitNumber: SECRET,
    category: SECRET as never,
    inventoryIncidentType: SECRET as never,
    linenIncidentType: SECRET as never,
    evidenceReceived: SECRET as never,
    accountableParty: [SECRET as never],
  }

  it('warnings never carry the offending value (all warning codes exercised)', () => {
    for (const v of [writable(), writable({ drop: ['1210401516520213'] })]) {
      const r = resolveCustomFields(desired, v)
      expect(r.warnings.length).toBeGreaterThan(0)
      expect(JSON.stringify(r.warnings)).not.toContain('70523138')
      expect(JSON.stringify(r.warnings)).not.toContain('Jane')
    }
  })

  it('the structured log holds codes and GIDs only', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = resolveCustomFields(desired, writable())
    logFieldWarnings({ flagId: 'f1', projectGid: ASANA_TEST_PROJECT_GID }, writable().issues, r.warnings)
    const line = spy.mock.calls[0].join(' ')
    expect(line).toContain('unknown_option')
    expect(line).not.toContain('70523138')
    expect(line).not.toContain('Jane')
    spy.mockClear()
    logFieldWarnings({ flagId: 'f1', projectGid: 'p' }, [], [])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ----------------------------------------------------------------
// Paginated READ-ONLY client + non-throwing loader
// ----------------------------------------------------------------

type Page = { data: unknown; next_page?: { offset?: unknown } | null }

function pagesFetch(pages: Array<Page | (() => Response | Promise<Response>)>) {
  let i = 0
  return vi.fn(async () => {
    const p = pages[Math.min(i++, pages.length - 1)]
    if (typeof p === 'function') return p()
    return { ok: true, status: 200, headers: new Headers(), json: async () => p, text: async () => '' } as unknown as Response
  })
}

function settingsPage(fields: Field[], projectGid = ASANA_TEST_PROJECT_GID) {
  return fields.map((f) => ({ gid: `s-${f.gid}`, project: { gid: projectGid }, custom_field: f }))
}

describe('getProjectCustomFieldSettings — paginated READ-ONLY GET', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('MULTIPLE PAGES: follows next_page.offset and combines every setting before validation', async () => {
    const fetchMock = pagesFetch([
      { data: settingsPage(LIVE_FIELDS.slice(0, 3)), next_page: { offset: 'o1' } },
      { data: settingsPage(LIVE_FIELDS.slice(3, 6)), next_page: { offset: 'o2' } },
      { data: settingsPage(LIVE_FIELDS.slice(6)), next_page: null },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const meta = await getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(meta.custom_field_settings).toHaveLength(LIVE_FIELDS.length)
    const urls = fetchMock.mock.calls.map((c) => decodeURIComponent(String((c as unknown[])[0])))
    expect(urls[0]).toContain(`/projects/${ASANA_TEST_PROJECT_GID}/custom_field_settings?`)
    expect(urls[0]).toContain('limit=100')
    expect(urls[0]).not.toContain('offset=')
    expect(urls[1]).toContain('offset=o1')
    expect(urls[2]).toContain('offset=o2')
    for (const c of fetchMock.mock.calls) {
      expect(((c as unknown[])[1] as { method: string; body?: unknown }).method).toBe('GET')
      expect(((c as unknown[])[1] as { body?: unknown }).body).toBeUndefined()
    }
    // A field only on the LAST page is still validated.
    const v = validateWritableFieldConfig(BETA_MIRROR, meta)
    expect(v.ok).toBe(true)
  })

  it('REPEATED OFFSET: stops and throws (never loops)', async () => {
    const fetchMock = pagesFetch([
      { data: [], next_page: { offset: 'same' } },
      { data: [], next_page: { offset: 'same' } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await expect(getProjectCustomFieldSettings('tok', 'p')).rejects.toThrow(/repeated an offset/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('UNREASONABLE PAGE COUNT: stops at the page cap', async () => {
    let n = 0
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), text: async () => '',
      json: async () => ({ data: [], next_page: { offset: `o${n++}` } }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(getProjectCustomFieldSettings('tok', 'p')).rejects.toThrow(/exceeded/)
    expect(fetchMock).toHaveBeenCalledTimes(FIELD_SETTINGS_MAX_PAGES)
  })

  it('malformed page / malformed offset throw', async () => {
    vi.stubGlobal('fetch', pagesFetch([{ data: 'nope' }]))
    await expect(getProjectCustomFieldSettings('tok', 'p')).rejects.toThrow(/malformed/)
    vi.stubGlobal('fetch', pagesFetch([{ data: [], next_page: { offset: 7 } }]))
    await expect(getProjectCustomFieldSettings('tok', 'p')).rejects.toThrow(/offset is malformed/)
  })
})

describe('loadWritableFieldValidation — every read failure means NO usable fields, never a failed task', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const httpError = (status: number) => () =>
    ({
      ok: false,
      status,
      headers: new Headers(status === 429 ? { 'retry-after': '30' } : {}),
      text: async () => `upstream said: token secret-token-xyz rejected`,
      json: async () => ({}),
    }) as unknown as Response

  it.each([401, 403, 404, 429, 500, 503])('HTTP %i -> schema_unavailable, nothing usable, no throw', async (status) => {
    vi.stubGlobal('fetch', pagesFetch([httpError(status)]))
    const v = await loadWritableFieldValidation('secret-token-xyz', BETA_MIRROR)
    expect(v.usable).toEqual({})
    expect(v.issues).toEqual([expect.objectContaining({ code: 'schema_unavailable', status })])
    expect(JSON.stringify(v.issues)).not.toContain('secret-token-xyz') // no body, no token
    expect(resolveCustomFields({ category: 'inventory' }, v).customFields).toEqual({})
  })

  it('NETWORK FAILURE -> schema_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const v = await loadWritableFieldValidation('tok', BETA_MIRROR)
    expect(v.usable).toEqual({})
    expect(v.issues[0]).toMatchObject({ code: 'schema_unavailable' })
    expect(v.issues[0].status).toBeUndefined()
  })

  it('MALFORMED JSON -> schema_unavailable', async () => {
    vi.stubGlobal('fetch', pagesFetch([() => ({
      ok: true, status: 200, headers: new Headers(), text: async () => '{',
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
    }) as unknown as Response]))
    const v = await loadWritableFieldValidation('tok', BETA_MIRROR)
    expect(v.usable).toEqual({})
    expect(v.issues[0].code).toBe('schema_unavailable')
  })

  it('a REPEATED-OFFSET loop -> schema_unavailable (no throw)', async () => {
    vi.stubGlobal('fetch', pagesFetch([{ data: [], next_page: { offset: 'x' } }, { data: [], next_page: { offset: 'x' } }]))
    const v = await loadWritableFieldValidation('tok', BETA_MIRROR)
    expect(v.usable).toEqual({})
    expect(v.issues[0].code).toBe('schema_unavailable')
  })

  it('a good read validates (pages combined) and the result can resolve', async () => {
    vi.stubGlobal('fetch', pagesFetch([
      { data: settingsPage(LIVE_FIELDS.slice(0, 4)), next_page: { offset: 'a' } },
      { data: settingsPage(LIVE_FIELDS.slice(4)), next_page: null },
    ]))
    const v = await loadWritableFieldValidation('tok', BETA_MIRROR)
    expect(v.ok).toBe(true)
    expect(resolveCustomFields({ evidenceReceived: 'yes' }, v).customFields).toEqual({
      '1211426871181279': '1211426871181280',
    })
  })

  it('INSPECTION of live works read-only and its result is still not writable', async () => {
    vi.stubGlobal('fetch', pagesFetch([{ data: settingsPage(LIVE_FIELDS, LIVE_INCIDENTS_PROJECT_GID), next_page: null }]))
    const v = await inspectFieldConfig('tok', LIVE_INCIDENTS_FIELD_REFERENCE)
    expect(v.ok).toBe(true)
    // @ts-expect-error -- inspection results are never writable
    expect(() => resolveCustomFields({ category: 'inventory' }, v)).toThrow(TypeError)
  })
})
