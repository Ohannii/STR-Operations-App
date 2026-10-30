/**
 * Read-only Asana custom-field SCHEMA VALIDATION + value resolution
 * (Phase 1, hardened). PURE — no I/O. Project metadata comes from the
 * paginated read-only GET (client.getProjectCustomFieldSettings), loaded
 * without throwing by field-schema.ts, and is passed in.
 *
 * Fail-closed contract (per-field, ratified by review — NOT all-or-nothing):
 *   - Fields and options are matched by GID only — never by name.
 *   - Wrong / missing project identity, an unreadable page, or an
 *     unavailable schema (HTTP / network / pagination failure)
 *                                              -> NO field is usable.
 *   - One field missing / malformed / wrong type -> only that field is dropped;
 *     a malformed field the integration does not use is ignored.
 *   - One option missing / disabled            -> only that option is dropped.
 *   - Dependent fields stay coherent: an incident subtype is emitted only
 *     together with its own Category (Inventory / Linen).
 *   - Accountable Party is all-or-nothing; Evidence Received is independent.
 *   - Unmapped or unusable values are OMITTED with a structured warning that
 *     carries codes, field keys and GIDs only — never a value, guest data or
 *     a token. Nothing is ever guessed.
 *
 * WRITE BOUNDARY: only a validation of WRITABLE configuration (branded, see
 * field-config.ts) can reach resolveCustomFields, and the resolver re-checks
 * the hard project allowlist at runtime. Phase 1 does not write custom
 * fields: nothing in the worker calls this yet.
 */

import { assertAllowedProject } from '@/lib/integrations/asana/config'
import {
  EXPECTED_FIELD_TYPES,
  isWritableFieldConfig,
  type AccountableOption,
  type AsanaFieldType,
  type CategoryOption,
  type EvidenceOption,
  type IncidentFieldKey,
  type InventoryIncidentOption,
  type LinenIncidentOption,
  type ProjectFieldConfig,
  type WritableFieldConfig,
} from '@/lib/integrations/asana/field-config'

// ----------------------------------------------------------------
// Project metadata (combined pages of GET /projects/{gid}/custom_field_settings)
// ----------------------------------------------------------------

export type ProjectFieldMetadata = {
  gid: string
  /**
   * GIDs of fields whose own metadata is unusable (missing subtype, enum
   * options missing / malformed, an option without GID or enabled state).
   * They invalidate ONLY themselves — never the rest of the schema.
   */
  malformedFieldGids: ReadonlySet<string>
  custom_field_settings: Array<{
    project: { gid: string }
    custom_field: {
      gid: string
      resource_subtype: string
      enum_options?: Array<{ gid: string; enabled: boolean }>
    }
  }>
}

const ENUM_TYPES = new Set(['enum', 'multi_enum'])

/**
 * Defensive parse of an untrusted response. Granularity (review, 30 Oct):
 *   - null (WHOLE schema unusable): not an object, no project GID, settings
 *     not an array, or ANY setting whose parent project (`parent`, or the
 *     deprecated `project` alias) is missing or is another project;
 *   - one field malformed (missing subtype; enum / multi_enum without a
 *     complete option list; an option without GID or enabled state)
 *     -> recorded in malformedFieldGids, invalidating ONLY that field;
 *   - a setting whose field GID cannot be read cannot be attributed to any
 *     field: it is skipped (a configured field it might have been simply
 *     reports field_missing).
 * Nothing is assumed from a compact or partial representation.
 */
export function parseProjectFieldMetadata(raw: unknown): ProjectFieldMetadata | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.gid !== 'string' || !r.gid || !Array.isArray(r.custom_field_settings)) return null
  const settings: ProjectFieldMetadata['custom_field_settings'] = []
  const malformedFieldGids = new Set<string>()
  for (const s of r.custom_field_settings) {
    const setting = s as { parent?: unknown; project?: unknown; custom_field?: unknown } | null
    // PROJECT IDENTITY (whole schema): `parent` (current API) preferred,
    // `project` (deprecated alias) accepted. One MUST be present and equal
    // THIS project, for every setting.
    const parent = (setting?.parent ?? setting?.project) as Record<string, unknown> | undefined
    if (!parent || parent.gid !== r.gid) return null
    const cf = setting?.custom_field as Record<string, unknown> | undefined
    // No readable field GID: cannot be attributed to any field -> skipped.
    if (!cf || typeof cf.gid !== 'string' || !cf.gid) continue
    // From here on a defect invalidates ONLY this field.
    if (typeof cf.resource_subtype !== 'string' || !cf.resource_subtype) {
      malformedFieldGids.add(cf.gid)
      continue
    }
    let options: Array<{ gid: string; enabled: boolean }> | undefined
    if (ENUM_TYPES.has(cf.resource_subtype)) {
      const rawOptions = Array.isArray(cf.enum_options) ? cf.enum_options : null
      const parsed = rawOptions?.map((o) => {
        const opt = o as Record<string, unknown> | null
        return opt && typeof opt.gid === 'string' && opt.gid && typeof opt.enabled === 'boolean'
          ? { gid: opt.gid, enabled: opt.enabled }
          : null
      })
      if (!parsed || parsed.some((o) => o === null)) {
        malformedFieldGids.add(cf.gid) // incomplete option list: unusable field
        continue
      }
      options = parsed as Array<{ gid: string; enabled: boolean }>
    }
    settings.push({
      project: { gid: r.gid },
      custom_field: {
        gid: cf.gid,
        resource_subtype: cf.resource_subtype,
        ...(options ? { enum_options: options } : {}),
      },
    })
  }
  return { gid: r.gid, malformedFieldGids, custom_field_settings: settings }
}

// ----------------------------------------------------------------
// Validation
// ----------------------------------------------------------------

export type FieldIssueCode =
  | 'schema_unavailable'
  | 'project_mismatch'
  | 'metadata_malformed'
  | 'config_type_mismatch'
  | 'field_malformed'
  | 'field_missing'
  | 'wrong_type'
  | 'option_missing'
  | 'option_disabled'

export type FieldIssue = {
  code: FieldIssueCode
  field?: IncidentFieldKey
  fieldGid?: string
  option?: string
  optionGid?: string
  /** HTTP status when the schema could not be read (no body, no message). */
  status?: number
  detail: string
}

export type UsableField = {
  gid: string
  type: AsanaFieldType
  /** Semantic option key -> GID, ONLY for options proven present + enabled. */
  options: Readonly<Record<string, string>>
  /** Every ENABLED option GID in the project (for dynamic options). */
  enabledOptionGids: ReadonlySet<string>
  dynamicOptions: boolean
}

export type FieldValidation = {
  projectGid: string
  ok: boolean
  usable: Readonly<Partial<Record<IncidentFieldKey, UsableField>>>
  issues: FieldIssue[]
}

const WRITABLE_VALIDATION: unique symbol = Symbol('asana.writableFieldValidation')
/** A validation of WRITABLE configuration — the only input the resolver accepts. */
export type WritableFieldValidation = FieldValidation & { readonly [WRITABLE_VALIDATION]: true }

/** Nothing usable (schema unreadable, wrong project, malformed, …). */
export function emptyValidation(projectGid: string, issue: FieldIssue): FieldValidation {
  return { projectGid, ok: false, usable: {}, issues: [issue] }
}

/** INSPECTION: validate any configuration (live reference included). */
export function validateFieldConfig(
  config: ProjectFieldConfig,
  rawMetadata: unknown,
): FieldValidation {
  const issues: FieldIssue[] = []
  const metadata = parseProjectFieldMetadata(rawMetadata)
  if (!metadata) {
    return emptyValidation(config.projectGid, {
      code: 'metadata_malformed',
      detail: 'Project metadata is unreadable or its project identity is missing/wrong.',
    })
  }
  if (metadata.gid !== config.projectGid) {
    return emptyValidation(config.projectGid, {
      code: 'project_mismatch',
      detail: `Configuration is for project ${config.projectGid} but metadata is for ${metadata.gid}.`,
    })
  }

  const byGid = new Map(metadata.custom_field_settings.map((s) => [s.custom_field.gid, s.custom_field]))
  const usable: Partial<Record<IncidentFieldKey, UsableField>> = {}

  for (const key of Object.keys(config.fields) as IncidentFieldKey[]) {
    const spec = config.fields[key]
    if (!spec) continue
    if (spec.type !== EXPECTED_FIELD_TYPES[key]) {
      issues.push({
        code: 'config_type_mismatch',
        field: key,
        fieldGid: spec.gid,
        detail: `Configured as ${spec.type}; ${key} must be ${EXPECTED_FIELD_TYPES[key]}.`,
      })
      continue
    }
    if (metadata.malformedFieldGids.has(spec.gid)) {
      issues.push({
        code: 'field_malformed',
        field: key,
        fieldGid: spec.gid,
        detail: `Field ${spec.gid} has incomplete or malformed metadata.`,
      })
      continue
    }
    const remote = byGid.get(spec.gid)
    if (!remote) {
      issues.push({
        code: 'field_missing',
        field: key,
        fieldGid: spec.gid,
        detail: `Field ${spec.gid} is not on project ${config.projectGid}.`,
      })
      continue
    }
    if (remote.resource_subtype !== spec.type) {
      issues.push({
        code: 'wrong_type',
        field: key,
        fieldGid: spec.gid,
        detail: `Project field is ${remote.resource_subtype}; configured ${spec.type}.`,
      })
      continue
    }

    const isEnum = ENUM_TYPES.has(spec.type)
    const enabledOptionGids = new Set(
      isEnum ? (remote.enum_options ?? []).filter((o) => o.enabled).map((o) => o.gid) : [],
    )
    const knownOptionGids = new Set(isEnum ? (remote.enum_options ?? []).map((o) => o.gid) : [])
    const options: Record<string, string> = {}
    for (const [optionKey, optionGid] of Object.entries(spec.options ?? {})) {
      if (!knownOptionGids.has(optionGid)) {
        issues.push({
          code: 'option_missing',
          field: key,
          fieldGid: spec.gid,
          option: optionKey,
          optionGid,
          detail: `Option ${optionGid} (${optionKey}) does not exist on field ${spec.gid}.`,
        })
      } else if (!enabledOptionGids.has(optionGid)) {
        issues.push({
          code: 'option_disabled',
          field: key,
          fieldGid: spec.gid,
          option: optionKey,
          optionGid,
          detail: `Option ${optionGid} (${optionKey}) is disabled on field ${spec.gid}.`,
        })
      } else {
        options[optionKey] = optionGid
      }
    }
    usable[key] = {
      gid: spec.gid,
      type: spec.type,
      options,
      enabledOptionGids,
      dynamicOptions: spec.dynamicOptions === true,
    }
  }

  return { projectGid: config.projectGid, ok: issues.length === 0, usable, issues }
}

/**
 * WRITE PATH validation. Accepts only branded writable configuration and
 * re-checks the project allowlist at runtime (defence against casts).
 */
export function validateWritableFieldConfig(
  config: WritableFieldConfig,
  rawMetadata: unknown,
): WritableFieldValidation {
  if (!isWritableFieldConfig(config)) {
    throw new TypeError('Writable Asana field configuration is required')
  }
  assertAllowedProject(config.projectGid)
  return { ...validateFieldConfig(config, rawMetadata), [WRITABLE_VALIDATION]: true as const }
}

/** WRITE PATH: no usable fields (e.g. the schema could not be read). */
export function unavailableWritableValidation(
  config: WritableFieldConfig,
  issue: FieldIssue,
): WritableFieldValidation {
  if (!isWritableFieldConfig(config)) {
    throw new TypeError('Writable Asana field configuration is required')
  }
  assertAllowedProject(config.projectGid)
  return { ...emptyValidation(config.projectGid, issue), [WRITABLE_VALIDATION]: true as const }
}

function isWritableValidation(v: unknown): v is WritableFieldValidation {
  return (
    typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[WRITABLE_VALIDATION] === true
  )
}

// ----------------------------------------------------------------
// Resolution: desired app values -> Asana custom_fields payload
// ----------------------------------------------------------------

/** What the app would like to set. Every entry is optional. */
export type DesiredFieldValues = {
  /** Per-property option GID from an explicit mapping (never matched by name). */
  unitOptionGid?: string
  unitNumber?: string
  category?: CategoryOption
  inventoryIncidentType?: InventoryIncidentOption
  linenIncidentType?: LinenIncidentOption
  evidenceReceived?: EvidenceOption
  accountableParty?: AccountableOption[]
}

/** Asana create-task `custom_fields` values. */
export type AsanaFieldValue = string | string[]

export type ResolveWarningCode =
  | 'field_unusable'
  | 'unmapped_value'
  | 'unknown_option'
  | 'empty_value'
  | 'dependency_unmet'

/** Codes + field keys only: never the offending value, guest data or a token. */
export type ResolveWarning = {
  code: ResolveWarningCode
  field: IncidentFieldKey
  detail: string
}

export type ResolvedFields = {
  customFields: Record<string, AsanaFieldValue>
  warnings: ResolveWarning[]
}

const TEXT_MAX = 1024

/** The Category each incident subtype belongs to. */
const SUBTYPE_CATEGORY = {
  inventoryIncidentType: 'inventory',
  linenIncidentType: 'linen',
} as const satisfies Partial<Record<IncidentFieldKey, CategoryOption>>

export function resolveCustomFields(
  desired: DesiredFieldValues,
  validation: WritableFieldValidation,
): ResolvedFields {
  // Runtime re-check: an inspection-only (e.g. live) validation can never
  // reach a write, even through a cast.
  if (!isWritableValidation(validation)) {
    throw new TypeError('A writable field validation is required to resolve custom fields')
  }
  assertAllowedProject(validation.projectGid)

  const customFields: Record<string, AsanaFieldValue> = {}
  const warnings: ResolveWarning[] = []

  const usable = (field: IncidentFieldKey): UsableField | null => {
    const u = validation.usable[field]
    if (!u) {
      warnings.push({
        code: 'field_unusable',
        field,
        detail: `${field} is not configured or failed validation on project ${validation.projectGid}.`,
      })
      return null
    }
    return u
  }

  /** Emits an enum option; returns true when it was emitted. */
  const enumOption = (field: IncidentFieldKey, key: string | undefined): boolean => {
    if (key === undefined) return false
    const u = usable(field)
    if (!u) return false
    const gid = u.options[key]
    if (!gid) {
      warnings.push({
        code: 'unmapped_value',
        field,
        detail: `No usable option is configured for the requested ${field} value.`,
      })
      return false
    }
    customFields[u.gid] = gid
    return true
  }

  // Unit #: a per-property option GID, accepted ONLY if the project shows it enabled.
  if (desired.unitOptionGid !== undefined) {
    const u = usable('unit')
    if (u) {
      if (!u.dynamicOptions || !u.enabledOptionGids.has(desired.unitOptionGid)) {
        warnings.push({
          code: 'unknown_option',
          field: 'unit',
          detail: 'The unit option is not an enabled option of the project field.',
        })
      } else {
        customFields[u.gid] = [desired.unitOptionGid]
      }
    }
  }

  if (desired.unitNumber !== undefined) {
    const u = usable('unitNumber')
    if (u) {
      const text = desired.unitNumber.trim()
      if (!text) {
        warnings.push({ code: 'empty_value', field: 'unitNumber', detail: 'Unit number is blank.' })
      } else {
        customFields[u.gid] = text.slice(0, TEXT_MAX)
      }
    }
  }

  // CATEGORY first: the subtypes below depend on what was ACTUALLY emitted.
  const emittedCategory = enumOption('category', desired.category) ? desired.category : undefined

  // DEPENDENCY COHERENCE: a subtype is emitted only together with its own
  // Category. A missing / invalid / unmapped / different Category omits the
  // subtype — the subtype never drags the Category down with it.
  for (const field of ['inventoryIncidentType', 'linenIncidentType'] as const) {
    const key = desired[field]
    if (key === undefined) continue
    if (emittedCategory !== SUBTYPE_CATEGORY[field]) {
      warnings.push({
        code: 'dependency_unmet',
        field,
        detail: `${field} requires Category = ${SUBTYPE_CATEGORY[field]} to be emitted; omitted.`,
      })
      continue
    }
    enumOption(field, key)
  }

  // Evidence Received: independent of everything else.
  enumOption('evidenceReceived', desired.evidenceReceived)

  // Accountable Party: ALL selections must map, or the field is omitted
  // entirely — a partial "who pays" would be worse than none.
  if (desired.accountableParty !== undefined) {
    const u = usable('accountableParty')
    if (u) {
      const keys = [...new Set(desired.accountableParty)]
      const gids = keys.map((k) => u.options[k])
      if (keys.length === 0) {
        warnings.push({ code: 'empty_value', field: 'accountableParty', detail: 'No party selected.' })
      } else if (gids.some((g) => !g)) {
        warnings.push({
          code: 'unmapped_value',
          field: 'accountableParty',
          detail: 'At least one party has no usable option; the field is omitted.',
        })
      } else {
        customFields[u.gid] = gids as string[]
      }
    }
  }

  return { customFields, warnings }
}

/**
 * Structured warning log. Codes, field keys, GIDs and HTTP status only —
 * never a value, a message body, guest/personal data or a token.
 */
export function logFieldWarnings(
  context: { flagId: string; projectGid: string },
  issues: ReadonlyArray<FieldIssue>,
  warnings: ReadonlyArray<ResolveWarning>,
): void {
  if (issues.length === 0 && warnings.length === 0) return
  console.warn(
    '[asana-fields]',
    JSON.stringify({
      flagId: context.flagId,
      projectGid: context.projectGid,
      issues: issues.map((i) => ({
        code: i.code,
        field: i.field,
        fieldGid: i.fieldGid,
        optionGid: i.optionGid,
        status: i.status,
      })),
      warnings: warnings.map((w) => ({ code: w.code, field: w.field })),
    }),
  )
}
