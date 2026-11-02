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
import {
  createWritableFieldValidationLoader,
  inspectFieldConfig,
  loadWritableFieldValidation,
} from '@/lib/integrations/asana/field-schema'
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

  it('(2B-1) BETA config holds EXACTLY the verified field and option GIDs (2 Nov 2026)', () => {
    expect(BETA_FIELD_CONFIG.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    expect(BETA_FIELD_CONFIG.fields).toEqual({
      unit: { gid: '1213116492387386', type: 'multi_enum', dynamicOptions: true },
      unitNumber: { gid: '1210401516520213', type: 'text' },
      category: {
        gid: '1220057630679849',
        type: 'enum',
        options: { inventory: '1220057630679850', maintenance: '1220057630679851', linen: '1220057630679852' },
      },
      inventoryIncidentType: {
        gid: '1220057630679854',
        type: 'enum',
        options: { missing_item: '1220057561518784', physical_damage: '1220057561518785' },
      },
      linenIncidentType: {
        gid: '1220057561518787',
        type: 'enum',
        options: { missing: '1220057561518788', stain: '1220057561518789', torn_irreparable: '1220057561518790' },
      },
      evidenceReceived: { gid: '1220057561518792', type: 'enum', options: { yes: '1220057561518793' } },
      accountableParty: {
        gid: '1220057561518796',
        type: 'multi_enum',
        options: { guest: '1220057561518797', drop_inn: '1220057561518798', investor: '1220057561518799' },
      },
    })
    // BETA-only copies never reuse a live project-local GID (only the two library fields are shared).
    const liveGids = new Set(Object.values(LIVE_INCIDENTS_FIELD_REFERENCE.fields).map((f) => f?.gid))
    const shared = Object.values(BETA_FIELD_CONFIG.fields).filter((f) => liveGids.has(f?.gid)).map((f) => f?.gid)
    expect(shared.sort()).toEqual(['1210401516520213', '1213116492387386'])
    // "No" exists in BETA (1220057561518794) but is never mapped.
    expect(Object.values(BETA_FIELD_CONFIG.fields.evidenceReceived?.options ?? {})).not.toContain('1220057561518794')
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

describe('source contracts — read-only, by GID, wired ONLY through the writable BETA path', () => {
  const files = ['field-config.ts', 'field-validation.ts', 'field-schema.ts', 'field-mapping.ts']

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

  it('BOUNDARY: only the provider, the worker and the worker route import the field modules', () => {
    const allowed = new Set([
      'src/lib/integrations/asana/provider.ts', // BETA field-GID guard (configForWrite)
      'src/lib/integrations/worker/process-outbox.ts', // mapping + resolver
      'src/app/api/integrations/asana/worker/route.ts', // per-request writable loader
    ])
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = read(rel)
          if (/asana\/field-(config|validation|schema|mapping)/.test(src) && !rel.includes('/asana/field-')) {
            importers.push(rel)
          }
        }
      }
    }
    walk('src')
    expect(importers.sort()).toEqual([...allowed].sort())
  })

  it('BOUNDARY: custom fields reach the client ONLY from resolveCustomFields over a WRITABLE BETA validation', () => {
    const worker = code(read('src/lib/integrations/worker/process-outbox.ts'))
    // The only producer of request fields in the worker is the resolver.
    expect(worker).toMatch(/resolveCustomFields\(mapped\.desired, validation\)/)
    expect(worker).toMatch(/hasCustomFields\(resolved\.customFields\) \? resolved\.customFields : undefined/)
    expect(worker.match(/customFields\s*[:=]/g)?.length ?? 0).toBeLessThanOrEqual(3)
    // The validation comes ONLY from the injected writable loader.
    expect(worker).toMatch(/load: \(\) => Promise<WritableFieldValidation>/)
    expect(worker).not.toMatch(/validateFieldConfig|inspectFieldConfig|LIVE_INCIDENTS/)
    // The route builds that loader from configForWrite(ASANA_TEST_PROJECT_GID) only.
    const route = code(read('src/app/api/integrations/asana/worker/route.ts'))
    expect(route).toContain('createWritableFieldValidationLoader(asanaToken, configForWrite(ASANA_TEST_PROJECT_GID))')
    expect(route).not.toMatch(/LIVE_INCIDENTS|inspectFieldConfig/)
    // The client sends custom_fields only behind the non-empty guard; no update endpoint.
    const client = code(read('src/lib/integrations/asana/client.ts'))
    expect(client.match(/custom_fields:/g)).toHaveLength(1)
    expect(client).toContain('...(hasCustomFields(args.customFields) ? { custom_fields: args.customFields } : {})')
    expect(client).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/)
    // The provider checks project, then BETA field GIDs, before the request.
    const provider = code(read('src/lib/integrations/asana/provider.ts'))
    expect(provider.indexOf('assertAllowedProject(payload.projectGid)')).toBeLessThan(
      provider.indexOf('assertBetaCustomFields(payload.projectGid, customFields)'),
    )
    expect(provider.indexOf('assertBetaCustomFields(payload.projectGid, customFields)')).toBeLessThan(
      provider.indexOf('createTaskInProject(token'),
    )
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

  it('MISSING FIELD: a BETA project without its fields reports every configured field missing', () => {
    const v = validateFieldConfig(BETA_FIELD_CONFIG, { gid: ASANA_TEST_PROJECT_GID, custom_field_settings: [] })
    expect(v.usable).toEqual({})
    expect(v.issues.map((i) => [i.code, i.field])).toEqual([
      ['field_missing', 'unit'],
      ['field_missing', 'unitNumber'],
      ['field_missing', 'category'],
      ['field_missing', 'inventoryIncidentType'],
      ['field_missing', 'linenIncidentType'],
      ['field_missing', 'evidenceReceived'],
      ['field_missing', 'accountableParty'],
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

  it('MISSING CONFIG: a BETA project without its fields yields a task WITHOUT custom fields, plus warnings', () => {
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

describe('PHASE 2B — the REAL BETA configuration against the REAL seven-field BETA schema', () => {
  /**
   * BETA metadata as read from Asana on 2 Nov 2026 — GIDs, subtypes and
   * enabled flags ONLY (no names: identity is the GID). Unit # carries a
   * representative subset including its one DISABLED option.
   */
  const B = ASANA_TEST_PROJECT_GID
  const setting = (gid: string, subtype: string, options?: Array<[string, boolean]>) => ({
    project: { gid: B },
    custom_field: {
      gid,
      resource_subtype: subtype,
      ...(options ? { enum_options: options.map(([g, enabled]) => ({ gid: g, enabled })) } : {}),
    },
  })
  const BETA_SCHEMA = {
    gid: B,
    custom_field_settings: [
      setting('1213116492387386', 'multi_enum', [
        ['1213116492387387', true],
        ['1214009753087420', true],
        ['1213373539419812', true],
        ['1213132578818915', false], // disabled in Asana
      ]),
      setting('1210401516520213', 'text'),
      setting('1220057630679849', 'enum', [['1220057630679850', true], ['1220057630679851', true], ['1220057630679852', true]]),
      setting('1220057630679854', 'enum', [['1220057561518784', true], ['1220057561518785', true]]),
      setting('1220057561518787', 'enum', [['1220057561518788', true], ['1220057561518789', true], ['1220057561518790', true]]),
      setting('1220057561518792', 'enum', [['1220057561518793', true], ['1220057561518794', true]]),
      setting('1220057561518796', 'multi_enum', [['1220057561518797', true], ['1220057561518798', true], ['1220057561518799', true]]),
    ],
  }
  const realBeta = () => validateWritableFieldConfig(configForWrite(ASANA_TEST_PROJECT_GID), BETA_SCHEMA)

  it('(2B-2/3) validates with ZERO issues and all seven fields usable', () => {
    const v = realBeta()
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
    expect(Object.keys(v.usable).sort()).toEqual([
      'accountableParty', 'category', 'evidenceReceived', 'inventoryIncidentType',
      'linenIncidentType', 'unit', 'unitNumber',
    ])
  })

  it('(2B-4) Inventory / Missing Item + Evidence Yes + Guest -> exact payload, no warnings', () => {
    const r = resolveCustomFields(
      {
        unitOptionGid: '1214009753087420',
        unitNumber: '50',
        category: 'inventory',
        inventoryIncidentType: 'missing_item',
        evidenceReceived: 'yes',
        accountableParty: ['guest'],
      },
      realBeta(),
    )
    expect(r.warnings).toEqual([])
    expect(r.customFields).toEqual({
      '1213116492387386': ['1214009753087420'],
      '1210401516520213': '50',
      '1220057630679849': '1220057630679850',
      '1220057630679854': '1220057561518784',
      '1220057561518792': '1220057561518793',
      '1220057561518796': ['1220057561518797'],
    })
  })

  it('(2B-5) Linen: the Linen subtype is included ONLY with Category = Linen', () => {
    const linen = resolveCustomFields({ category: 'linen', linenIncidentType: 'torn_irreparable' }, realBeta())
    expect(linen.warnings).toEqual([])
    expect(linen.customFields).toEqual({
      '1220057630679849': '1220057630679852',
      '1220057561518787': '1220057561518790',
    })
    const wrong = resolveCustomFields({ category: 'inventory', linenIncidentType: 'stain' }, realBeta())
    expect(wrong.customFields).toEqual({ '1220057630679849': '1220057630679850' })
    expect(wrong.warnings).toEqual([expect.objectContaining({ code: 'dependency_unmet', field: 'linenIncidentType' })])
  })

  it('(2B-6) Maintenance produces NO Inventory or Linen subtype', () => {
    const r = resolveCustomFields(
      { category: 'maintenance', inventoryIncidentType: 'physical_damage', linenIncidentType: 'missing' },
      realBeta(),
    )
    expect(r.customFields).toEqual({ '1220057630679849': '1220057630679851' })
    expect(r.customFields['1220057630679854']).toBeUndefined()
    expect(r.customFields['1220057561518787']).toBeUndefined()
  })

  it('(2B-7) disabled or unknown Unit # options are omitted safely; everything else still goes', () => {
    for (const gid of ['1213132578818915' /* disabled */, '9999999999999999' /* unknown */]) {
      const r = resolveCustomFields({ unitOptionGid: gid, evidenceReceived: 'yes' }, realBeta())
      expect(r.customFields).toEqual({ '1220057561518792': '1220057561518793' })
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'unknown_option', field: 'unit' })])
    }
  })

  it('(2B-8) the live project / config still cannot pass the BETA write boundary', () => {
    expect(() => configForWrite(LIVE_INCIDENTS_PROJECT_GID)).toThrow(DisallowedAsanaProjectError)
    expect(() => writableFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE)).toThrow(DisallowedAsanaProjectError)
    // A BETA config pointed at the LIVE schema invalidates everything (wrong project).
    const v = validateWritableFieldConfig(configForWrite(ASANA_TEST_PROJECT_GID), liveMetadata())
    expect(v.usable).toEqual({})
    expect(v.issues).toEqual([expect.objectContaining({ code: 'project_mismatch' })])
    // And BETA's schema can never satisfy the live reference either.
    expect(validateFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE, BETA_SCHEMA).issues).toEqual([
      expect.objectContaining({ code: 'project_mismatch' }),
    ])
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

describe('PAGINATION FAILS CLOSED — a damaged next_page is never read as "no more pages"', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const firstPageThen = (nextPage: unknown, include = true) =>
    pagesFetch([
      (include
        ? { data: settingsPage(LIVE_FIELDS.slice(0, 3)), next_page: nextPage }
        : { data: settingsPage(LIVE_FIELDS.slice(0, 3)) }) as Page,
      { data: settingsPage(LIVE_FIELDS.slice(3)), next_page: null },
    ])

  it('(1) MISSING next_page throws (would otherwise accept a truncated schema)', async () => {
    const fetchMock = firstPageThen(undefined, false)
    vi.stubGlobal('fetch', fetchMock)
    await expect(getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).rejects.toThrow(
      /pagination is malformed/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('(2) next_page = {} throws (no offset)', async () => {
    vi.stubGlobal('fetch', firstPageThen({}))
    await expect(getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).rejects.toThrow(
      /offset is malformed/,
    )
  })

  it.each([
    ['a string', 'o1'],
    ['a number', 7],
    ['a boolean', true],
    ['an array', [{ offset: 'o1' }]],
  ])('(3) next_page as %s throws', async (_label, nextPage) => {
    vi.stubGlobal('fetch', firstPageThen(nextPage))
    await expect(getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).rejects.toThrow(
      /pagination is malformed/,
    )
  })

  it.each([['empty', ''], ['spaces', '   '], ['tabs/newlines', '\t\n'], ['missing', undefined]])(
    '(4) an offset that is %s throws',
    async (_label, offset) => {
      vi.stubGlobal('fetch', firstPageThen(offset === undefined ? {} : { offset }))
      await expect(getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).rejects.toThrow(
        /offset is malformed/,
      )
    },
  )

  it('(5) next_page = null still completes normally (single and multi page)', async () => {
    vi.stubGlobal('fetch', pagesFetch([{ data: settingsPage(LIVE_FIELDS), next_page: null }]))
    expect((await getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).custom_field_settings)
      .toHaveLength(LIVE_FIELDS.length)
    vi.stubGlobal('fetch', firstPageThen({ offset: 'o1' }))
    expect((await getProjectCustomFieldSettings('tok', ASANA_TEST_PROJECT_GID)).custom_field_settings)
      .toHaveLength(LIVE_FIELDS.length)
  })

  it.each([
    ['missing next_page', undefined, false],
    ['next_page = {}', {}, true],
    ['next_page = "o1"', 'o1', true],
    ['blank offset', { offset: '  ' }, true],
  ])('(6) %s becomes schema_unavailable through the loader (nothing usable, no throw)', async (_l, np, include) => {
    vi.stubGlobal('fetch', firstPageThen(np, include as boolean))
    const v = await loadWritableFieldValidation('tok', BETA_MIRROR)
    expect(v.usable).toEqual({})
    expect(v.issues).toEqual([expect.objectContaining({ code: 'schema_unavailable' })])
    expect(resolveCustomFields({ category: 'inventory', evidenceReceived: 'yes' }, v).customFields).toEqual({})
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

describe('createWritableFieldValidationLoader — one memoised load per request', () => {
  it('memoises SUCCESS: many calls, one schema read', async () => {
    const fetchSchema = vi.fn(async () => betaMetadataFromConfig())
    const load = createWritableFieldValidationLoader('tok', configForWrite(ASANA_TEST_PROJECT_GID), fetchSchema)
    const [a, b, c] = await Promise.all([load(), load(), load()])
    expect(fetchSchema).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a.ok).toBe(true)
  })

  it('memoises FAILURE: an unavailable schema is not re-read within the request, and never rejects', async () => {
    const fetchSchema = vi.fn(async () => { throw new TypeError('fetch failed') })
    const load = createWritableFieldValidationLoader('tok', configForWrite(ASANA_TEST_PROJECT_GID), fetchSchema)
    const v1 = await load()
    const v2 = await load()
    expect(fetchSchema).toHaveBeenCalledTimes(1)
    expect(v1).toBe(v2)
    expect(v1.usable).toEqual({})
    expect(v1.issues[0].code).toBe('schema_unavailable')
  })

  it('cannot be built for the live reference', () => {
    expect(() =>
      createWritableFieldValidationLoader('tok', configForWrite(LIVE_INCIDENTS_PROJECT_GID)),
    ).toThrow(DisallowedAsanaProjectError)
  })

  it('a schema read that HANGS is bounded by the request timeout (unavailable, not stuck)', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((_u: string, init: { signal: AbortSignal }) =>
        new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
      ))
      const p = loadWritableFieldValidation('tok', configForWrite(ASANA_TEST_PROJECT_GID))
      await vi.advanceTimersByTimeAsync(30_000)
      const v = await p
      expect(v.usable).toEqual({})
      expect(v.issues[0].code).toBe('schema_unavailable')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

function betaMetadataFromConfig() {
  return {
    gid: ASANA_TEST_PROJECT_GID,
    custom_field_settings: Object.values(BETA_FIELD_CONFIG.fields).map((spec) => ({
      project: { gid: ASANA_TEST_PROJECT_GID },
      custom_field: {
        gid: spec!.gid,
        resource_subtype: spec!.type,
        ...(spec!.type === 'enum' || spec!.type === 'multi_enum'
          ? { enum_options: Object.values(spec!.options ?? {}).map((gid) => ({ gid, enabled: true })) }
          : {}),
      },
    })),
  }
}
