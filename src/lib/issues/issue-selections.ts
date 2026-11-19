/**
 * Issue SELECTIONS for "Report issue" from a pre-arrival photo — the quick
 * Asana-style choices staff make (Category, incident type, "What needs to
 * happen?", optional Severity / Fix Owner).
 *
 * PURE and client-safe: semantic keys + labels + validation only. Asana
 * field/option GIDs live per project in the Asana field configuration;
 * this module never contains a GID, so it is identical for BETA and live.
 *
 * The SAME rules are enforced in SQL (migration 20261119090000: CHECK
 * constraints + finalize_flag_issue_with_photos), so a direct RPC call
 * cannot store anything this parser would reject.
 */

export const ISSUE_CATEGORIES = [
  { key: 'inventory', label: 'Inventory' },
  { key: 'linen', label: 'Linen' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'hoa', label: 'HOA' },
  { key: 'amenity', label: 'Amenity' },
  { key: 'permanent_fixtures', label: 'Permanent fixtures' },
] as const

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]['key']

/** Incident types that apply per Category (Asana: INVENTORY / Linen / HOA Incident type). */
export const ISSUE_INCIDENT_TYPES = {
  inventory: [
    { key: 'physical_damage', label: 'Physical damage' },
    { key: 'missing_item', label: 'Missing item' },
    { key: 'appliance_failure', label: 'Appliance failure' },
    { key: 'stain_to_furniture', label: 'Stain to furniture' },
    { key: 'lost_keys', label: 'Lost keys' },
    { key: 'lost_remote', label: 'Lost remote' },
    { key: 'old_damage', label: 'Old damage' },
    { key: 'wear_and_tear', label: 'Wear & tear' },
    { key: 'irrecoverable', label: 'Irrecoverable' },
    { key: 'other', label: 'Other' },
  ],
  linen: [
    { key: 'stain', label: 'Stain' },
    { key: 'torn_irreparable', label: 'Torn / irreparable' },
    { key: 'missing', label: 'Missing' },
    { key: 'wear_and_tear', label: 'Wear & tear' },
    { key: 'other', label: 'Other' },
  ],
  hoa: [
    { key: 'noise_complaint', label: 'Noise complaint' },
    { key: 'facilities', label: 'Facilities' },
    { key: 'warning_1', label: 'Warning 1' },
    { key: 'warning_2', label: 'Warning 2' },
    { key: 'warning_3_fine', label: 'Warning 3 – fine' },
  ],
} as const

export type IncidentCategory = keyof typeof ISSUE_INCIDENT_TYPES

/** "What needs to happen?" → Asana "Replacement Required" (multi-select). */
export const ISSUE_ACTIONS = [
  { key: 'fix', label: 'Fix' },
  { key: 'clean', label: 'Clean' },
  { key: 'replace', label: 'Replace' },
  { key: 'na', label: 'N/A' },
  { key: 'record_keeping', label: 'Record keeping' },
] as const

export type IssueAction = (typeof ISSUE_ACTIONS)[number]['key']

/** Optional, for triage (Asana "Severity"). Distinct from the app's own priority. */
export const ISSUE_SEVERITIES = [
  { key: 'minor', label: 'Minor' },
  { key: 'moderate', label: 'Moderate' },
  { key: 'major', label: 'Major' },
  { key: 'write_off', label: 'Write off' },
] as const

export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]['key']

/** Optional, for triage (Asana "Fix Owner"). */
export const ISSUE_FIX_OWNERS = [
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'housekeeping', label: 'Housekeeping' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'drop_inn', label: 'Drop-Inn' },
] as const

export type IssueFixOwner = (typeof ISSUE_FIX_OWNERS)[number]['key']

export type IssueSelections = {
  category: IssueCategory | null
  incidentType: string | null
  actions: IssueAction[]
  severity: IssueSeverity | null
  fixOwner: IssueFixOwner | null
}

export const EMPTY_SELECTIONS: IssueSelections = {
  category: null,
  incidentType: null,
  actions: [],
  severity: null,
  fixOwner: null,
}

const has = <T extends { key: string }>(list: readonly T[], key: unknown): key is T['key'] =>
  typeof key === 'string' && list.some((o) => o.key === key)

export function incidentTypesFor(
  category: IssueCategory | null,
): ReadonlyArray<{ readonly key: string; readonly label: string }> {
  return category && category in ISSUE_INCIDENT_TYPES
    ? ISSUE_INCIDENT_TYPES[category as IncidentCategory]
    : []
}

/** N/A means "nothing needs to happen" — it cannot be combined with an action. */
export function toggleAction(current: IssueAction[], key: IssueAction): IssueAction[] {
  if (current.includes(key)) return current.filter((a) => a !== key)
  if (key === 'na') return ['na']
  return [...current.filter((a) => a !== 'na'), key]
}

/** Canonical action order (matches ISSUE_ACTIONS) for stable storage/compare. */
function canonicalActions(actions: IssueAction[]): IssueAction[] {
  return ISSUE_ACTIONS.map((a) => a.key).filter((k) => actions.includes(k))
}

export type ParseResult = { ok: true; value: IssueSelections } | { ok: false; error: string }

/**
 * Server-side validation of untrusted selections. Unknown keys/values are
 * REJECTED (never silently dropped), an incident type must belong to the
 * chosen Category, and N/A cannot be combined with another action.
 */
export function parseIssueSelections(input: unknown): ParseResult {
  if (input === null || input === undefined) return { ok: true, value: { ...EMPTY_SELECTIONS } }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Invalid issue details.' }
  }
  const raw = input as Record<string, unknown>
  for (const k of Object.keys(raw)) {
    if (!['category', 'incidentType', 'actions', 'severity', 'fixOwner'].includes(k)) {
      return { ok: false, error: 'Invalid issue details.' }
    }
  }
  const blank = (v: unknown) => v === null || v === undefined || v === ''

  const category = blank(raw.category) ? null : raw.category
  if (category !== null && !has(ISSUE_CATEGORIES, category)) {
    return { ok: false, error: 'Unknown category.' }
  }

  const incidentType = blank(raw.incidentType) ? null : raw.incidentType
  if (incidentType !== null) {
    if (!has(incidentTypesFor(category as IssueCategory | null), incidentType)) {
      return { ok: false, error: 'That incident type does not match the category.' }
    }
  }

  const actionsRaw = raw.actions === undefined || raw.actions === null ? [] : raw.actions
  if (!Array.isArray(actionsRaw) || actionsRaw.length > ISSUE_ACTIONS.length) {
    return { ok: false, error: 'Invalid “What needs to happen?” selection.' }
  }
  if (!actionsRaw.every((a) => has(ISSUE_ACTIONS, a))) {
    return { ok: false, error: 'Unknown “What needs to happen?” option.' }
  }
  const actions = canonicalActions(Array.from(new Set(actionsRaw as IssueAction[])))
  if (actions.includes('na') && actions.length > 1) {
    return { ok: false, error: 'N/A cannot be combined with another action.' }
  }

  const severity = blank(raw.severity) ? null : raw.severity
  if (severity !== null && !has(ISSUE_SEVERITIES, severity)) {
    return { ok: false, error: 'Unknown severity.' }
  }
  const fixOwner = blank(raw.fixOwner) ? null : raw.fixOwner
  if (fixOwner !== null && !has(ISSUE_FIX_OWNERS, fixOwner)) {
    return { ok: false, error: 'Unknown fix owner.' }
  }

  return {
    ok: true,
    value: {
      category: category as IssueCategory | null,
      incidentType: incidentType as string | null,
      actions,
      severity: severity as IssueSeverity | null,
      fixOwner: fixOwner as IssueFixOwner | null,
    },
  }
}

/** JSON sent to the RPC (snake_case, nulls explicit). */
export function selectionsToRpc(s: IssueSelections) {
  return {
    category: s.category,
    incident_type: s.incidentType,
    actions: s.actions,
    severity: s.severity,
    fix_owner: s.fixOwner,
  }
}

/** Stored row (snake_case) → selections. Unknown stored values are dropped. */
export function selectionsFromRow(row: {
  category: string | null
  incident_type: string | null
  actions: string[] | null
  severity: string | null
  fix_owner: string | null
}): IssueSelections {
  const parsed = parseIssueSelections({
    category: row.category,
    incidentType: row.incident_type,
    actions: row.actions ?? [],
    severity: row.severity,
    fixOwner: row.fix_owner,
  })
  return parsed.ok ? parsed.value : { ...EMPTY_SELECTIONS }
}

/**
 * Prefill from the app issue type ONLY where the match is certain (approved
 * D1 mapping). Everything else is left for the reporter to choose.
 */
export function prefillFromIssueType(issueTypeKey: string): Pick<IssueSelections, 'category' | 'incidentType'> {
  switch (issueTypeKey) {
    case 'maintenance_issue':
      return { category: 'maintenance', incidentType: null }
    case 'inventory_missing':
      return { category: 'inventory', incidentType: 'missing_item' }
    case 'inventory_damaged':
      return { category: 'inventory', incidentType: 'physical_damage' }
    default:
      return { category: null, incidentType: null }
  }
}
