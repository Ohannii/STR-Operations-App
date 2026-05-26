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
// Chargeable party decision
// ----------------------------------------------------------------
export type ChargeableParty =
  | 'guest'
  | 'owner'
  | 'company'
  | 'contractor'
  | 'pending_decision'

const CHARGEABLE_MAP: Record<ChargeableParty, { label: string; tone: BadgeTone }> = {
  guest: { label: 'Guest', tone: 'orange' },
  owner: { label: 'Owner', tone: 'amber' },
  company: { label: 'Company', tone: 'sky' },
  contractor: { label: 'Contractor', tone: 'slate' },
  pending_decision: { label: 'Pending', tone: 'slate' },
}

export const CHARGEABLE_PARTIES: ChargeableParty[] = [
  'guest',
  'owner',
  'company',
  'contractor',
  'pending_decision',
]

export function chargeablePartyDisplay(value: string | null | undefined): {
  label: string
  tone: BadgeTone
} {
  if (!value) return { label: 'Unset', tone: 'slate' }
  if ((Object.keys(CHARGEABLE_MAP) as ChargeableParty[]).includes(value as ChargeableParty)) {
    return CHARGEABLE_MAP[value as ChargeableParty]
  }
  return { label: value, tone: 'slate' }
}

// Status transitions that should clear / set the close timestamp.
export function isTerminalStatus(status: string): boolean {
  return status === 'closed' || status === 'no_action'
}
