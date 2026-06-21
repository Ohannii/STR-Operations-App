/**
 * Display helpers for the flag lifecycle fields:
 *   - status         (raised / classified / actioned / closed / no_action)
 *   - chargeable_party_decision   (guest / owner / company / contractor / pending_decision)
 *
 * Pattern matches property-status.ts and flag-category.ts so the UI
 * has one consistent source of truth for label + tone + icon per
 * enum-style value.
 */

import {
  ArchiveX,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  PlayCircle,
  type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from '@/components/ui/badge'

export type FlagStatus = 'raised' | 'classified' | 'actioned' | 'closed' | 'no_action'

const STATUS_MAP: Record<FlagStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  raised: { label: 'Raised', tone: 'amber', icon: CircleDashed },
  classified: { label: 'Classified', tone: 'sky', icon: ClipboardList },
  actioned: { label: 'Actioned', tone: 'blue', icon: PlayCircle },
  closed: { label: 'Closed', tone: 'emerald', icon: CheckCircle2 },
  no_action: { label: 'No action', tone: 'slate', icon: ArchiveX },
}

export const FLAG_STATUSES: FlagStatus[] = [
  'raised',
  'classified',
  'actioned',
  'closed',
  'no_action',
]

export function flagStatusDisplay(status: string): {
  label: string
  tone: BadgeTone
  icon: LucideIcon
} {
  if ((Object.keys(STATUS_MAP) as FlagStatus[]).includes(status as FlagStatus)) {
    return STATUS_MAP[status as FlagStatus]
  }
  return { label: status, tone: 'slate', icon: CircleDashed }
}

// ----------------------------------------------------------------
// Accountability (stored in flags.chargeable_party_decision)
// ----------------------------------------------------------------
// Session 9A Slice 1: "who may bear the cost/responsibility" is a
// dimension separate from the issue category. The column is free
// text (no DB CHECK), so the vocabulary is governed here in code.
//
// CURRENT vocabulary (offered in triage; default = needs_triage):
//   needs_triage, guest_damage, owner_wear_tear, owner_chargeable,
//   company_absorbed, contractor_fault, cleaning_team, hoa_building,
//   internal_ops
//
// LEGACY values still present on existing rows (kept for display +
// validation so old flags never become unsavable; NOT offered in the
// picker): guest, owner, company, contractor, pending_decision.

export type ChargeableParty =
  | 'needs_triage'
  | 'guest_damage'
  | 'owner_wear_tear'
  | 'owner_chargeable'
  | 'company_absorbed'
  | 'contractor_fault'
  | 'cleaning_team'
  | 'hoa_building'
  | 'internal_ops'

/** Default accountability for a freshly reported issue. */
export const DEFAULT_ACCOUNTABILITY: ChargeableParty = 'needs_triage'

/** Current vocabulary offered in the triage picker, in display order. */
export const CHARGEABLE_PARTIES: ChargeableParty[] = [
  'needs_triage',
  'guest_damage',
  'owner_wear_tear',
  'owner_chargeable',
  'company_absorbed',
  'contractor_fault',
  'cleaning_team',
  'hoa_building',
  'internal_ops',
]

// Display map covers current + legacy values so every stored value
// renders cleanly.
const CHARGEABLE_MAP: Record<string, { label: string; tone: BadgeTone }> = {
  needs_triage: { label: 'Not sure / needs triage', tone: 'slate' },
  guest_damage: { label: 'Guest damage', tone: 'orange' },
  owner_wear_tear: { label: 'Owner — wear & tear', tone: 'amber' },
  owner_chargeable: { label: 'Owner — chargeable', tone: 'amber' },
  company_absorbed: { label: 'Company absorbed', tone: 'sky' },
  contractor_fault: { label: 'Contractor / maintenance fault', tone: 'slate' },
  cleaning_team: { label: 'Cleaning team', tone: 'blue' },
  hoa_building: { label: 'HOA / building', tone: 'slate' },
  internal_ops: { label: 'Internal operations', tone: 'slate' },
  // Legacy
  guest: { label: 'Guest damage', tone: 'orange' },
  owner: { label: 'Owner — chargeable', tone: 'amber' },
  company: { label: 'Company absorbed', tone: 'sky' },
  contractor: { label: 'Contractor / maintenance fault', tone: 'slate' },
  pending_decision: { label: 'Not sure / needs triage', tone: 'slate' },
}

/** Every value accepted by triage validation (current + legacy). */
export const VALID_CHARGEABLE_VALUES: string[] = [
  ...CHARGEABLE_PARTIES,
  'guest',
  'owner',
  'company',
  'contractor',
  'pending_decision',
]

/**
 * Map any stored value (current or legacy) to the current canonical
 * value, so a triage picker can pre-select one option for old flags.
 */
export function normaliseAccountability(value: string | null | undefined): ChargeableParty {
  switch (value) {
    case 'guest':
      return 'guest_damage'
    case 'owner':
      return 'owner_chargeable'
    case 'company':
      return 'company_absorbed'
    case 'contractor':
      return 'contractor_fault'
    case 'pending_decision':
    case null:
    case undefined:
    case '':
      return 'needs_triage'
    default:
      return (CHARGEABLE_PARTIES as string[]).includes(value)
        ? (value as ChargeableParty)
        : 'needs_triage'
  }
}

export function chargeablePartyDisplay(value: string | null | undefined): {
  label: string
  tone: BadgeTone
} {
  if (!value) return CHARGEABLE_MAP.needs_triage
  if (value in CHARGEABLE_MAP) return CHARGEABLE_MAP[value]
  return { label: value, tone: 'slate' }
}

// Status transitions that should clear / set the close timestamp.
export function isTerminalStatus(status: string): boolean {
  return status === 'closed' || status === 'no_action'
}
