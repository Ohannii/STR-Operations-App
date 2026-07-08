/**
 * Pure flag → Asana task payload mapping (Slice 3).
 *
 * No I/O, no network, no secrets. Given a plain snapshot of a flag it
 * returns the task payload a provider would create. Two safety/among
 * design points baked in:
 *
 *  - The target project is ALWAYS the pinned BETA test project, and we
 *    re-assert that via assertAllowedProject — a bug can never point a
 *    task at a live project.
 *  - Guest charges are the main recovery workflow, so guest-chargeable
 *    accountability is made visually unmissable: a `[GUEST CHARGE]`
 *    name prefix and a marked body line. (For the beta we do NOT
 *    override section routing — routing stays category-based.)
 *
 * Routing reuses the app's existing category-group logic
 * (flagCategoryGroupId) rather than duplicating it.
 */

import { flagCategoryGroupId, FLAG_CATEGORY_GROUPS } from '@/lib/ui/flag-category'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_WORKSPACE_GID,
  assertAllowedProject,
  sectionGidForGroup,
} from '@/lib/integrations/asana/config'
import type { TaskPayload } from '@/lib/integrations/types'

/**
 * Raw `chargeable_party_decision` values that mean "the guest pays".
 * Includes the legacy 'guest' alongside the canonical 'guest_damage'.
 */
const GUEST_CHARGEABLE_ACCOUNTABILITY = new Set<string>(['guest_damage', 'guest'])

/** Max length of the summary portion of the task name. */
const SUMMARY_MAX = 70

/**
 * A plain, provider-agnostic snapshot of a flag. The caller (a later
 * wiring slice) is responsible for reading these off the flag and its
 * relations — keeping this function pure and unit-testable.
 */
export interface FlagForMapping {
  id: string
  description: string
  severity: 'low' | 'med' | 'high'
  categoryKey: string
  categoryLabel: string
  /** Raw chargeable_party_decision (or null when not yet decided). */
  accountability: string | null
  /** Human label for accountability (caller formats via app helpers). */
  accountabilityLabel: string
  propertyName: string
  propertyId: string
  reporterName: string
  raisedAtIso: string
  status: string
  /** Base URL of the app (no trailing slash needed). */
  appBaseUrl: string
  /** YYYY-MM-DD; when provided, safety flags get this as a due date. */
  todayIso?: string
}

/** True when the guest is the chargeable party. */
export function isGuestChargeable(accountability: string | null): boolean {
  return accountability != null && GUEST_CHARGEABLE_ACCOUNTABILITY.has(accountability)
}

function groupLabel(groupId: string | null): string {
  return FLAG_CATEGORY_GROUPS.find((g) => g.id === groupId)?.label ?? 'Other'
}

function summarise(description: string): string {
  const firstLine = (description.split(/\r?\n/)[0] ?? '').trim()
  if (firstLine.length <= SUMMARY_MAX) return firstLine
  return firstLine.slice(0, SUMMARY_MAX - 1).trimEnd() + '…'
}

function severityLabel(severity: FlagForMapping['severity']): string {
  return severity === 'high' ? 'High' : severity === 'med' ? 'Medium' : 'Low'
}

/**
 * Build the Asana task payload for a flag. Pure. Always targets the
 * pinned BETA test project; section is chosen by category group.
 */
export function mapFlagToTaskPayload(flag: FlagForMapping): TaskPayload {
  const groupId = flagCategoryGroupId(flag.categoryKey)
  const sectionGid = sectionGidForGroup(groupId)
  const projectGid = ASANA_TEST_PROJECT_GID
  // Belt-and-braces: this can only ever be the pinned project, but we
  // assert so any future change that breaks that fails loudly in tests.
  assertAllowedProject(projectGid)

  const guestCharge = isGuestChargeable(flag.accountability)
  const namePrefix = guestCharge ? '[GUEST CHARGE] ' : ''
  const name = `${namePrefix}[${groupLabel(groupId)}] ${flag.propertyName} — ${summarise(flag.description)}`

  const appUrl = `${flag.appBaseUrl.replace(/\/+$/, '')}/properties/${flag.propertyId}/flags/${flag.id}`

  const notes = [
    'Reported in the Drop-Inn STR app.',
    '',
    `Property:        ${flag.propertyName}`,
    `Category:        ${flag.categoryLabel}`,
    `Severity:        ${severityLabel(flag.severity)}`,
    `Chargeable to:   ${flag.accountabilityLabel}${guestCharge ? '   <- GUEST CHARGE' : ''}`,
    `Reported by:     ${flag.reporterName}`,
    `Reported at:     ${flag.raisedAtIso}`,
    `Status:          ${flag.status}`,
    '',
    'Description:',
    flag.description,
    '',
    `Open in app: ${appUrl}`,
    '',
    '- Auto-created by the STR app (BETA). Do not edit the "Open in app" link.',
  ].join('\n')

  const payload: TaskPayload = {
    workspaceGid: ASANA_WORKSPACE_GID,
    projectGid,
    sectionGid,
    name,
    notes,
  }

  if (groupId === 'safety' && flag.todayIso) {
    payload.dueOn = flag.todayIso
  }

  return payload
}
