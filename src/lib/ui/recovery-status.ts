/**
 * Display helpers for guest_recovery_tasks.status and
 * recovery_attempts.outcome. Same pattern as flag-status.ts.
 */

import {
  AlertOctagon,
  ArchiveX,
  CheckCircle2,
  Globe,
  Inbox,
  MessageSquare,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from '@/components/ui/badge'

// ---------------------------------------------------------------
// Task status
// ---------------------------------------------------------------
export type RecoveryStatus =
  | 'new'
  | 'guest_notified'
  | 'guest_resolved'
  | 'ota_attempted'
  | 'ota_resolved'
  | 'fallback_decision'
  | 'closed'

const STATUS_MAP: Record<RecoveryStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  new:               { label: 'New',               tone: 'amber',   icon: Inbox },
  guest_notified:    { label: 'Guest notified',    tone: 'sky',     icon: MessageSquare },
  guest_resolved:    { label: 'Guest paid',        tone: 'emerald', icon: CheckCircle2 },
  ota_attempted:     { label: 'OTA claim filed',   tone: 'blue',    icon: Globe },
  ota_resolved:      { label: 'OTA paid',          tone: 'emerald', icon: CheckCircle2 },
  fallback_decision: { label: 'Awaiting fallback', tone: 'orange',  icon: AlertOctagon },
  closed:            { label: 'Closed',            tone: 'slate',   icon: ArchiveX },
}

export function recoveryStatusDisplay(status: string): {
  label: string
  tone: BadgeTone
  icon: LucideIcon
} {
  if ((Object.keys(STATUS_MAP) as RecoveryStatus[]).includes(status as RecoveryStatus)) {
    return STATUS_MAP[status as RecoveryStatus]
  }
  return { label: status, tone: 'slate', icon: Inbox }
}

export function isRecoveryTerminal(status: string): boolean {
  return (
    status === 'closed' ||
    status === 'guest_resolved' ||
    status === 'ota_resolved'
  )
}

// ---------------------------------------------------------------
// Attempt outcome
// ---------------------------------------------------------------
export type RecoveryOutcome =
  | 'paid_full'
  | 'paid_partial'
  | 'refused'
  | 'no_response'
  | 'denied'
  | 'pending'
  | 'approved_internal'
  | 'approved_owner'

const OUTCOME_MAP: Record<RecoveryOutcome, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  paid_full:         { label: 'Paid in full',     tone: 'emerald', icon: CheckCircle2 },
  paid_partial:      { label: 'Paid partial',     tone: 'amber',   icon: CheckCircle2 },
  refused:           { label: 'Refused',          tone: 'red',     icon: XCircle },
  no_response:       { label: 'No response',      tone: 'orange',  icon: AlertOctagon },
  denied:            { label: 'Denied',           tone: 'red',     icon: XCircle },
  pending:           { label: 'Pending',          tone: 'amber',   icon: Inbox },
  approved_internal: { label: 'Internal approve', tone: 'sky',     icon: CheckCircle2 },
  approved_owner:    { label: 'Owner approved',   tone: 'emerald', icon: CheckCircle2 },
}

export function outcomeDisplay(outcome: string | null | undefined): {
  label: string
  tone: BadgeTone
  icon: LucideIcon
} {
  if (!outcome) return { label: 'Pending', tone: 'amber', icon: Inbox }
  if ((Object.keys(OUTCOME_MAP) as RecoveryOutcome[]).includes(outcome as RecoveryOutcome)) {
    return OUTCOME_MAP[outcome as RecoveryOutcome]
  }
  return { label: outcome, tone: 'slate', icon: Inbox }
}
