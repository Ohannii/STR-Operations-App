/**
 * Asana custom-field configuration, PER PROJECT.
 *
 * Nothing here writes to Asana. It defines WHICH fields/options the app may
 * set, and field-validation.ts proves them against a project's live schema.
 * The verified BETA configuration is used ONLY for validated BETA task
 * creation (worker -> writable validation -> resolver -> provider BETA
 * field check). The live configuration remains read-only reference data:
 * it can be inspected, never made writable.
 *
 * RULES (from the 29–30 Oct audit):
 *   - Fields and options are identified ONLY by GID. Names are comments for
 *     humans. Live option names carry trailing spaces ("Maintenance ") and
 *     inconsistent unit spacing, so name matching is never used.
 *   - Configuration is per project. BETA and live are configured separately;
 *     a BETA GID is never assumed to equal a live GID (most live fields are
 *     project-local and cannot be attached to BETA as-is).
 *   - Only DETERMINISTIC, app-owned fields are declared. Severity Status,
 *     Month (ambiguous), costs and recovery are deliberately ABSENT — they
 *     are manager triage. Replacement Required (a routing trigger), Severity
 *     and Fix Owner are declared (Nov 2026) but are ONLY ever sent when the
 *     reporter explicitly chose them in "Report issue" (field-issue-mapping);
 *     the automatic flag mapping never produces them.
 *   - The write target remains the hard-pinned BETA project. The live
 *     configuration is a reference for validation only and can never be
 *     selected for a write (configForWrite asserts the project allowlist).
 */

import { ASANA_TEST_PROJECT_GID, assertAllowedProject } from '@/lib/integrations/asana/config'

export type AsanaFieldType = 'enum' | 'multi_enum' | 'text' | 'date' | 'number'

/**
 * The app-owned incident fields configured for the integration. Configured
 * is not emitted: the current mapping (field-mapping.ts) produces only
 * Category, INVENTORY Incident type and Evidence Received = Yes.
 */
export type IncidentFieldKey =
  | 'unit'
  | 'unitNumber'
  | 'category'
  | 'inventoryIncidentType'
  | 'linenIncidentType'
  | 'evidenceReceived'
  | 'accountableParty'
  // Nov 2026 "Report issue" selections (explicit reporter choices only).
  | 'hoaIncidentType'
  | 'replacementRequired'
  | 'severity'
  | 'fixOwner'

/** Semantic option keys the app may ever select, per enum field. */
export type CategoryOption =
  | 'inventory'
  | 'maintenance'
  | 'linen'
  | 'hoa'
  | 'amenity'
  | 'permanent_fixtures'
export type InventoryIncidentOption =
  | 'missing_item'
  | 'physical_damage'
  | 'appliance_failure'
  | 'stain_to_furniture'
  | 'lost_keys'
  | 'lost_remote'
  | 'old_damage'
  | 'wear_and_tear'
  | 'irrecoverable'
  | 'other'
export type LinenIncidentOption = 'missing' | 'stain' | 'torn_irreparable' | 'wear_and_tear' | 'other'
export type HoaIncidentOption =
  | 'noise_complaint'
  | 'facilities'
  | 'warning_1'
  | 'warning_2'
  | 'warning_3_fine'
/** "What needs to happen?" → Replacement Required (routing trigger). */
export type ReplacementRequiredOption = 'fix' | 'clean' | 'replace' | 'na' | 'record_keeping'
export type SeverityOption = 'minor' | 'moderate' | 'major' | 'write_off'
export type FixOwnerOption = 'maintenance' | 'housekeeping' | 'vendor' | 'drop_inn'
export type EvidenceOption = 'yes'
/**
 * Configured for FUTURE use only. The current mapping never emits Accountable
 * Party: it stays blank until a manager-verified source exists (D3).
 */
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
  hoaIncidentType: 'multi_enum',
  replacementRequired: 'multi_enum',
  severity: 'enum',
  fixOwner: 'enum',
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
 * Unit # and Unit Number are WORKSPACE-LIBRARY fields (same GIDs as live).
 * The other five are BETA-ONLY copies created by the Asana admin on 2 Nov
 * 2026 and verified read-only by GID, type, project membership and enabled
 * options. Their GIDs differ from live by design — never assume equality.
 * Evidence Received's "No" option exists in BETA but is deliberately not
 * mapped: the app never sets it.
 */
export const BETA_FIELD_CONFIG: ProjectFieldConfig = {
  projectGid: ASANA_TEST_PROJECT_GID,
  label: 'Drop-Inn STR — Integration Test (BETA)',
  fields: {
    unit: { gid: '1213116492387386', type: 'multi_enum', dynamicOptions: true }, // "Unit #" (library)
    unitNumber: { gid: '1210401516520213', type: 'text' }, // "Unit Number" (library)
    category: {
      gid: '1220057630679849', // "Category (BETA)"
      type: 'enum',
      options: {
        inventory: '1220057630679850', // "Inventory"
        maintenance: '1220057630679851', // "Maintenance"
        linen: '1220057630679852', // "Linen"
      },
    },
    inventoryIncidentType: {
      gid: '1220057630679854', // "INVENTORY Incident type (BETA)"
      type: 'enum',
      options: {
        missing_item: '1220057561518784', // "Missing Item"
        physical_damage: '1220057561518785', // "Physical Damage"
      },
    },
    linenIncidentType: {
      gid: '1220057561518787', // "Linen Incident type (BETA)"
      type: 'enum',
      options: {
        missing: '1220057561518788', // "Missing"
        stain: '1220057561518789', // "Stain"
        torn_irreparable: '1220057561518790', // "Torn/Irreparable"
      },
    },
    evidenceReceived: {
      gid: '1220057561518792', // "Evidence Received (BETA)"
      type: 'enum',
      options: { yes: '1220057561518793' }, // "Yes" — "No" is never set by the app
    },
    accountableParty: {
      gid: '1220057561518796', // "Accountable Party (BETA)"
      type: 'multi_enum',
      options: {
        guest: '1220057561518797', // "Guest"
        drop_inn: '1220057561518798', // "Drop-Inn"
        investor: '1220057561518799', // "Investor"
      },
    },
  },
}

/** Live "Incidents & Damages Reporting" — REFERENCE ONLY, never a write target. */
export const LIVE_INCIDENTS_PROJECT_GID = '1211426202387126'
/** Live intake section "New (Intake" (verified read-only 19 Nov 2026). Reference only. */
export const LIVE_INCIDENTS_INTAKE_SECTION_GID = '1211426202387127'

/**
 * Live schema captured read-only on 29 Oct 2026; Report-issue fields and
 * options re-verified read-only on 19 Nov 2026. Used to validate the
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
        hoa: '1211554777729559', // "HOA"
        amenity: '1212912013664286', // "Amenity"
        permanent_fixtures: '1213885141063282', // "Permanent Fixtures"
      },
    },
    inventoryIncidentType: {
      gid: '1211490712226261', // "INVENTORY Incident type"
      type: 'enum',
      options: {
        missing_item: '1211490712226263', // "Missing Item"
        physical_damage: '1211490712226262', // "Physical Damage"
        appliance_failure: '1211490712226264', // "Appliance failure"
        stain_to_furniture: '1211490712226265', // "Stain to furniture"
        other: '1211490712226266', // "Other"
        lost_keys: '1211572538971567', // "Lost Keys"
        lost_remote: '1211572538971568', // "Lost Remote"
        old_damage: '1211845256811346', // "Old Damage"
        wear_and_tear: '1211845256811347', // "Wear & Tear"
        irrecoverable: '1213006046000158', // "Irrecoverable"
      },
    },
    linenIncidentType: {
      gid: '1211490712226255', // "Linen Incident type"
      type: 'enum',
      options: {
        missing: '1211490712226258', // "Missing"
        stain: '1211490712226256', // "Stain"
        torn_irreparable: '1211490712226257', // "Torn/Irreparable"
        other: '1211490712226259', // "Other"
        wear_and_tear: '1213006046000157', // "WEAR & TEAR"
      },
    },
    hoaIncidentType: {
      gid: '1211554777729562', // "HOA Incident Type"
      type: 'multi_enum',
      options: {
        noise_complaint: '1211554777729563', // "Noise Complaint"
        facilities: '1211554777729564', // "Facilities"
        warning_1: '1213006046000159', // "Warning 1"
        warning_2: '1213006046000160', // "Warning 2"
        warning_3_fine: '1213006046000161', // "Warning 3 - Fine"
      },
    },
    replacementRequired: {
      gid: '1214079196883375', // "Replacement Required" — drives the live routing rules
      type: 'multi_enum',
      options: {
        fix: '1219681415359283', // "Fix"     → also added to Maintenance Control
        replace: '1219681415359284', // "Replace" → also added to STR Operations - Movement log
        clean: '1219681415359285', // "Clean"   → also added to DropInn Cleaning Control
        na: '1219681415359286', // "N/A"
        record_keeping: '1219931708456277', // "Record Keeping"
      },
    },
    severity: {
      gid: '1211426204541396', // "Severity"
      type: 'enum',
      options: {
        minor: '1211426204541397', // "Minor"
        moderate: '1211426204541398', // "Moderate"
        major: '1211426204541399', // "Major"
        write_off: '1211760099838569', // "Write Off"
      },
    },
    fixOwner: {
      gid: '1211426204541419', // "Fix Owner"
      type: 'enum',
      options: {
        maintenance: '1211426204541420', // "Maintenance"
        housekeeping: '1211426204541421', // "Housekeeping"
        vendor: '1211426204541422', // "Vendor"
        drop_inn: '1212001243165621', // "Drop-Inn"
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
