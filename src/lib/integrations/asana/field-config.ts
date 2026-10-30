/**
 * Asana custom-field configuration, PER PROJECT (Phase 1 — config only).
 *
 * Nothing here writes to Asana, and nothing here is wired into the worker
 * yet: Phase 1 only defines WHICH fields/options the app may one day set and
 * lets field-validation.ts prove them against a project's live schema.
 *
 * RULES (from the 29–30 Oct audit):
 *   - Fields and options are identified ONLY by GID. Names are comments for
 *     humans. Live option names carry trailing spaces ("Maintenance ") and
 *     inconsistent unit spacing, so name matching is never used.
 *   - Configuration is per project. BETA and live are configured separately;
 *     a BETA GID is never assumed to equal a live GID (most live fields are
 *     project-local and cannot be attached to BETA as-is).
 *   - Only DETERMINISTIC, app-owned fields are declared. Severity, Severity
 *     Status, Replacement Required (a routing trigger), Month (ambiguous),
 *     costs and recovery are deliberately ABSENT — they are manager triage.
 *   - The write target remains the hard-pinned BETA project. The live
 *     configuration is a reference for validation only and can never be
 *     selected for a write (configForWrite asserts the project allowlist).
 */

import { ASANA_TEST_PROJECT_GID, assertAllowedProject } from '@/lib/integrations/asana/config'

export type AsanaFieldType = 'enum' | 'multi_enum' | 'text' | 'date' | 'number'

/** The app-owned incident fields the integration may populate. */
export type IncidentFieldKey =
  | 'unit'
  | 'unitNumber'
  | 'category'
  | 'inventoryIncidentType'
  | 'linenIncidentType'
  | 'evidenceReceived'
  | 'accountableParty'

/** Semantic option keys the app may ever select, per enum field. */
export type CategoryOption = 'inventory' | 'maintenance' | 'linen'
export type InventoryIncidentOption = 'missing_item' | 'physical_damage'
export type LinenIncidentOption = 'missing' | 'stain' | 'torn_irreparable'
export type EvidenceOption = 'yes'
/** Only verified one-to-one reporter selections (D2). */
export type AccountableOption = 'guest' | 'drop_inn' | 'investor'

/**
 * The Asana type each field MUST have. A configured field whose declared
 * type differs from this is a configuration error; a project whose field
 * has a different subtype is a schema mismatch. Either way the field is
 * not used.
 */
export const EXPECTED_FIELD_TYPES: Readonly<Record<IncidentFieldKey, AsanaFieldType>> = {
  unit: 'multi_enum',
  unitNumber: 'text',
  category: 'enum',
  inventoryIncidentType: 'enum',
  linenIncidentType: 'enum',
  evidenceReceived: 'enum',
  accountableParty: 'multi_enum',
}

export type FieldSpec = {
  gid: string
  type: AsanaFieldType
  /** Semantic option key -> enum option GID (enum / multi_enum only). */
  options?: Readonly<Record<string, string>>
  /**
   * The option is chosen per record from an external mapping (Unit #: a
   * per-property option GID), not from a fixed semantic set. The resolver
   * then only accepts option GIDs the live schema shows as ENABLED.
   */
  dynamicOptions?: boolean
}

export type ProjectFieldConfig = {
  projectGid: string
  label: string
  fields: Readonly<Partial<Record<IncidentFieldKey, FieldSpec>>>
}

/**
 * BETA: "Drop-Inn STR — Integration Test (BETA)".
 *
 * As of the 29 Oct audit the BETA project has NO custom fields. Only the two
 * WORKSPACE-LIBRARY fields (Unit #, Unit Number) keep their GIDs when added
 * to another project, so only they are declared here — the validator will
 * report them `field_missing` until an Asana admin adds them to BETA, which
 * is the intended fail-closed behaviour. The project-local fields (Category,
 * incident types, Evidence Received, Accountable Party) are added here ONLY
 * after the admin mirrors them into BETA and their real BETA GIDs have been
 * captured by a read-only GET.
 */
export const BETA_FIELD_CONFIG: ProjectFieldConfig = {
  projectGid: ASANA_TEST_PROJECT_GID,
  label: 'Drop-Inn STR — Integration Test (BETA)',
  fields: {
    unit: { gid: '1213116492387386', type: 'multi_enum', dynamicOptions: true }, // "Unit #" (library)
    unitNumber: { gid: '1210401516520213', type: 'text' }, // "Unit Number" (library)
  },
}

/** Live "Incidents & Damages Reporting" — REFERENCE ONLY, never a write target. */
export const LIVE_INCIDENTS_PROJECT_GID = '1211426202387126'

/**
 * Live schema captured read-only on 29 Oct 2026. Used to validate the
 * mapping design against the real project; configForWrite() refuses it.
 */
export const LIVE_INCIDENTS_FIELD_REFERENCE: ProjectFieldConfig = {
  projectGid: LIVE_INCIDENTS_PROJECT_GID,
  label: 'Incidents & Damages Reporting (live — reference only)',
  fields: {
    unit: { gid: '1213116492387386', type: 'multi_enum', dynamicOptions: true }, // "Unit #"
    unitNumber: { gid: '1210401516520213', type: 'text' }, // "Unit Number"
    category: {
      gid: '1211490712226251', // "Category"
      type: 'enum',
      options: {
        inventory: '1211490712226253', // "Inventory"
        maintenance: '1219255393409321', // "Maintenance " (trailing space in Asana)
        linen: '1211490712226252', // "Linen"
      },
    },
    inventoryIncidentType: {
      gid: '1211490712226261', // "INVENTORY Incident type"
      type: 'enum',
      options: {
        missing_item: '1211490712226263', // "Missing Item"
        physical_damage: '1211490712226262', // "Physical Damage"
      },
    },
    linenIncidentType: {
      gid: '1211490712226255', // "Linen Incident type"
      type: 'enum',
      options: {
        missing: '1211490712226258', // "Missing"
        stain: '1211490712226256', // "Stain"
        torn_irreparable: '1211490712226257', // "Torn/Irreparable"
      },
    },
    evidenceReceived: {
      gid: '1211426871181279', // "Evidence Received"
      type: 'enum',
      options: { yes: '1211426871181280' }, // "Yes" — "No" is never set by the app
    },
    accountableParty: {
      gid: '1211505770478165', // "Accountable Party"
      type: 'multi_enum',
      options: {
        guest: '1211505775360953', // "Guest"
        drop_inn: '1211505770478166', // "Drop-Inn"
        investor: '1213006046000163', // "Investor"
      },
    },
  },
}

const CONFIGS: readonly ProjectFieldConfig[] = [BETA_FIELD_CONFIG, LIVE_INCIDENTS_FIELD_REFERENCE]

/** Read-only lookup (validation / diagnostics). Unknown project -> null. */
export function fieldConfigForProject(projectGid: string): ProjectFieldConfig | null {
  return CONFIGS.find((c) => c.projectGid === projectGid) ?? null
}

/**
 * WRITABLE configuration — a distinct, branded type (hardening pass). A plain
 * ProjectFieldConfig (e.g. the live reference) is NOT assignable to it, so
 * nothing that requires writable configuration can be handed live config by
 * mistake; the only way to obtain one is writableFieldConfig(), which runs
 * the hard project allowlist first. Runtime re-checks back this up against
 * casts (see field-validation.ts).
 */
const WRITABLE_BRAND: unique symbol = Symbol('asana.writableFieldConfig')
export type WritableFieldConfig = ProjectFieldConfig & { readonly [WRITABLE_BRAND]: true }

export function isWritableFieldConfig(config: unknown): config is WritableFieldConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as Record<symbol, unknown>)[WRITABLE_BRAND] === true
  )
}

/**
 * Mint writable configuration. THROWS (DisallowedAsanaProjectError) for any
 * project other than the pinned BETA project — the live reference can be
 * inspected, never made writable.
 */
export function writableFieldConfig(config: ProjectFieldConfig): WritableFieldConfig {
  assertAllowedProject(config.projectGid)
  return Object.freeze({ ...config, [WRITABLE_BRAND]: true as const })
}

/**
 * The configuration for a WRITE. Enforces the existing hard project
 * allowlist first, so the live reference (or any other project) can never be
 * used to build a write — the BETA boundary is unchanged.
 */
export function configForWrite(projectGid: string): WritableFieldConfig {
  assertAllowedProject(projectGid)
  const config = fieldConfigForProject(projectGid)
  if (!config) throw new Error(`No Asana field configuration for project ${projectGid}`)
  return writableFieldConfig(config)
}

/** Static self-check: every declared field has its expected type. */
export function configTypeErrors(config: ProjectFieldConfig): IncidentFieldKey[] {
  return (Object.keys(config.fields) as IncidentFieldKey[]).filter(
    (k) => config.fields[k]?.type !== EXPECTED_FIELD_TYPES[k],
  )
}
