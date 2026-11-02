/**
 * Flag facts -> DESIRED BETA custom-field values (pure; no I/O).
 *
 * Only fields the app KNOWS are true are produced:
 *   - Category            from the structured flag_categories.key;
 *   - INVENTORY type      from the same key (Inventory only);
 *   - Evidence Received   = Yes when at least one durably stored photo
 *                           exists in the app (approved meaning: stored in
 *                           the app, not "already attached in Asana").
 *
 * Deliberately NEVER produced (approved): Unit #, Unit Number, Linen
 * Incident type, Accountable Party, and Evidence Received = No.
 *
 * Input is structured facts only — never names, notes, descriptions,
 * captions or any user-entered text. Option keys are the semantic keys of
 * field-config.ts; GIDs, schema checks and dependency rules stay in
 * field-validation.ts (resolveCustomFields), which this does not duplicate.
 */

import type {
  CategoryOption,
  InventoryIncidentOption,
} from '@/lib/integrations/asana/field-config'
import type { DesiredFieldValues, ResolveWarning } from '@/lib/integrations/asana/field-validation'

export type FlagFieldFacts = {
  /** flags.flag_category_id -> flag_categories.key (fresh DB read). */
  categoryKey: string | null | undefined
  /**
   * true  = at least one qualifying durable photo;
   * false = none;
   * null  = the evidence query failed (omitted, with a value-free warning).
   */
  durableEvidence: boolean | null
}

/** The ONLY category keys that map. Every other key is omitted. */
export const CATEGORY_FIELD_MAP: Readonly<
  Record<string, { category: CategoryOption; inventoryIncidentType?: InventoryIncidentOption }>
> = Object.freeze({
  maintenance_issue: { category: 'maintenance' },
  inventory_missing: { category: 'inventory', inventoryIncidentType: 'missing_item' },
  inventory_damaged: { category: 'inventory', inventoryIncidentType: 'physical_damage' },
})

export function desiredFieldValuesForFlag(facts: FlagFieldFacts): {
  desired: DesiredFieldValues
  warnings: ResolveWarning[]
} {
  const desired: DesiredFieldValues = {}
  const warnings: ResolveWarning[] = []

  const key = typeof facts.categoryKey === 'string' ? facts.categoryKey : ''
  const mapped = Object.prototype.hasOwnProperty.call(CATEGORY_FIELD_MAP, key)
    ? CATEGORY_FIELD_MAP[key]
    : undefined
  if (mapped) {
    desired.category = mapped.category
    if (mapped.inventoryIncidentType) desired.inventoryIncidentType = mapped.inventoryIncidentType
  } else if (key.trim() === '') {
    warnings.push({ code: 'empty_value', field: 'category', detail: 'No category key; Category omitted.' })
  } else {
    warnings.push({
      code: 'unmapped_value',
      field: 'category',
      detail: 'Category key has no BETA mapping; Category omitted.',
    })
  }

  if (facts.durableEvidence === true) {
    desired.evidenceReceived = 'yes'
  } else if (facts.durableEvidence === null) {
    warnings.push({
      code: 'source_unavailable',
      field: 'evidenceReceived',
      detail: 'Evidence could not be checked; Evidence Received omitted.',
    })
  }

  return { desired, warnings }
}
