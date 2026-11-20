/**
 * "Report issue" selections -> DESIRED Asana field values (pure; no I/O).
 *
 * Used ONLY for issues reported from a pre-arrival photo, where the
 * reporter explicitly chose the Asana-style details (stored in
 * flag_issue_selections). Every value here is the reporter's own choice;
 * nothing is inferred. Evidence Received keeps its approved meaning
 * (durable photo in the app). Unit # / Unit Number / Accountable Party are
 * still never produced.
 *
 * GIDs, schema checks and dependency rules stay in field-validation.ts.
 */

import type {
  DesiredFieldValues,
  ResolveWarning,
} from '@/lib/integrations/asana/field-validation'
import type {
  CategoryOption,
  HoaIncidentOption,
  InventoryIncidentOption,
  LinenIncidentOption,
} from '@/lib/integrations/asana/field-config'
import type { IssueSelections } from '@/lib/issues/issue-selections'

export function desiredFieldValuesForIssue(
  selections: IssueSelections,
  durableEvidence: boolean | null,
): { desired: DesiredFieldValues; warnings: ResolveWarning[] } {
  const desired: DesiredFieldValues = {}
  const warnings: ResolveWarning[] = []

  if (selections.category) {
    desired.category = selections.category as CategoryOption
    const t = selections.incidentType
    if (t) {
      if (selections.category === 'inventory') desired.inventoryIncidentType = t as InventoryIncidentOption
      else if (selections.category === 'linen') desired.linenIncidentType = t as LinenIncidentOption
      else if (selections.category === 'hoa') desired.hoaIncidentType = t as HoaIncidentOption
    }
  }
  if (selections.actions.length > 0) desired.replacementRequired = [...selections.actions]
  if (selections.severity) desired.severity = selections.severity
  if (selections.fixOwner) desired.fixOwner = selections.fixOwner

  if (durableEvidence === true) {
    desired.evidenceReceived = 'yes'
  } else if (durableEvidence === null) {
    warnings.push({
      code: 'source_unavailable',
      field: 'evidenceReceived',
      detail: 'Evidence could not be checked; Evidence Received omitted.',
    })
  }

  return { desired, warnings }
}
