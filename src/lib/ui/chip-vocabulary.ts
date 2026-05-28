/**
 * Operational chip vocabulary — source of truth in app code.
 *
 * Mirrors docs/CHIP_VOCABULARY.md. Each chip kind has:
 *   - a stable string identifier (stored in flag_operational_marks.kind)
 *   - a display label (operator-grade English)
 *   - a Lucide icon
 *   - a Badge tone
 *   - optional `replaces`: kinds that should be auto-cleared when this
 *     one is set (predecessor chains, e.g., asana_pending → asana_logged;
 *     maintenance_pending → maintenance_assigned → maintenance_done).
 *
 * Most workflows have a pending → completed pair so staff can actively
 * mark intent ("this needs Asana logging") rather than letting the
 * absence of a completed chip do the job. Two exceptions:
 *
 *   - `needs_reclean` is an active state on its own (cleaning is fast
 *     and same-day; the team toggles it off when the reclean is done).
 *     No companion `recleaned` chip in v1.0.
 *   - `awaiting_owner_approval` → `owner_approved` is a pre-existing
 *     pair (Session 6's first cut), not added in this round.
 *
 * The eligibility logic (which chips show on which flags) lives here
 * too so the flag detail page and the Action Centre flag-card row
 * agree on the same rules.
 *
 * Adding a new chip kind: add to ChipKind union + ALL_CHIP_KINDS +
 * CHIP_MAP + (optionally) eligibility logic + docs/CHIP_VOCABULARY.md.
 * No database migration required — the `kind` column is plain text by
 * design (see the migration's section 6 comment block).
 */

import {
  Calendar,
  ClipboardCheck,
  Hourglass,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from '@/components/ui/badge'

export type ChipKind =
  // Asana workflow
  | 'asana_pending'
  | 'asana_logged'
  // Guest notification workflow
  | 'guest_notify_pending'
  | 'guest_notified'
  // Owner notification workflow
  | 'owner_notify_pending'
  | 'owner_notified'
  // Maintenance workflow
  | 'maintenance_pending'
  | 'maintenance_assigned'
  | 'maintenance_done'
  // Replacement workflow
  | 'replacement_needed'
  | 'replaced'
  // Owner approval workflow
  | 'awaiting_owner_approval'
  | 'owner_approved'
  // Cleaning workflow (single-state for v1.0)
  | 'needs_reclean'

/**
 * Ordered list for UI presentation. The chip row on the flag detail
 * page renders in this order. Designed to flow:
 *   Asana → notifications → maintenance → replacement → approval → cleaning.
 */
export const ALL_CHIP_KINDS: ChipKind[] = [
  'asana_pending',
  'asana_logged',
  'guest_notify_pending',
  'guest_notified',
  'owner_notify_pending',
  'owner_notified',
  'maintenance_pending',
  'maintenance_assigned',
  'maintenance_done',
  'replacement_needed',
  'replaced',
  'awaiting_owner_approval',
  'owner_approved',
  'needs_reclean',
]

export type ChipDisplay = {
  kind: ChipKind
  label: string
  tone: BadgeTone
  icon: LucideIcon
  /**
   * Other chip kinds this one supersedes. When the user toggles this
   * chip on, any active marks of the kinds in this list get
   * cleared_at = now() in the same server action.
   *
   * Example: setting `asana_logged` clears `asana_pending`. Setting
   * `maintenance_done` clears both `maintenance_pending` and
   * `maintenance_assigned`.
   */
  replaces?: ChipKind[]
}

// All "pending" chips share the same visual treatment: amber tone
// (signals work-in-flight) + Hourglass icon (signals time-pressure).
// Completed chips inherit the workflow's signature icon (UserCheck for
// notifications, ClipboardCheck for Asana, etc.) with an emerald or
// sky tone signalling done.
const CHIP_MAP: Record<ChipKind, ChipDisplay> = {
  // ---------- Asana ----------
  asana_pending: {
    kind: 'asana_pending',
    label: 'Asana pending',
    tone: 'amber',
    icon: Hourglass,
  },
  asana_logged: {
    kind: 'asana_logged',
    label: 'Asana logged',
    tone: 'sky',
    icon: ClipboardCheck,
    replaces: ['asana_pending'],
  },

  // ---------- Guest notification ----------
  guest_notify_pending: {
    kind: 'guest_notify_pending',
    label: 'Guest notify pending',
    tone: 'amber',
    icon: Hourglass,
  },
  guest_notified: {
    kind: 'guest_notified',
    label: 'Guest notified',
    tone: 'emerald',
    icon: UserCheck,
    replaces: ['guest_notify_pending'],
  },

  // ---------- Owner notification ----------
  owner_notify_pending: {
    kind: 'owner_notify_pending',
    label: 'Owner notify pending',
    tone: 'amber',
    icon: Hourglass,
  },
  owner_notified: {
    kind: 'owner_notified',
    label: 'Owner notified',
    tone: 'emerald',
    icon: UserCheck,
    replaces: ['owner_notify_pending'],
  },

  // ---------- Maintenance ----------
  maintenance_pending: {
    kind: 'maintenance_pending',
    label: 'Maintenance pending',
    tone: 'amber',
    icon: Hourglass,
  },
  maintenance_assigned: {
    kind: 'maintenance_assigned',
    label: 'Maintenance assigned',
    tone: 'sky',
    icon: Calendar,
    replaces: ['maintenance_pending'],
  },
  maintenance_done: {
    kind: 'maintenance_done',
    label: 'Maintenance done',
    tone: 'emerald',
    icon: Wrench,
    replaces: ['maintenance_pending', 'maintenance_assigned'],
  },

  // ---------- Replacement ----------
  replacement_needed: {
    kind: 'replacement_needed',
    label: 'Replacement needed',
    tone: 'amber',
    icon: Hourglass,
  },
  replaced: {
    kind: 'replaced',
    label: 'Replaced',
    tone: 'emerald',
    icon: PackageCheck,
    replaces: ['replacement_needed'],
  },

  // ---------- Owner approval ----------
  awaiting_owner_approval: {
    kind: 'awaiting_owner_approval',
    label: 'Owner approval pending',
    tone: 'amber',
    icon: Hourglass,
  },
  owner_approved: {
    kind: 'owner_approved',
    label: 'Owner approved',
    tone: 'emerald',
    icon: ShieldCheck,
    replaces: ['awaiting_owner_approval'],
  },

  // ---------- Cleaning ----------
  // Single state: needs_reclean. Toggle off when the reclean is done.
  // No companion `recleaned` chip in v1.0 — see header comment.
  needs_reclean: {
    kind: 'needs_reclean',
    label: 'Needs reclean',
    tone: 'amber',
    icon: Sparkles,
  },
}

export function getChipDisplay(kind: string): ChipDisplay | undefined {
  if ((Object.keys(CHIP_MAP) as ChipKind[]).includes(kind as ChipKind)) {
    return CHIP_MAP[kind as ChipKind]
  }
  return undefined
}

export function listChipDisplays(): ChipDisplay[] {
  return ALL_CHIP_KINDS.map((k) => CHIP_MAP[k])
}

/**
 * Internal predicate used by both the detail toggle row and the
 * Action Centre's compact chip row. Keeps the two surfaces aligned.
 *
 * Pending and completed kinds in the same workflow share eligibility:
 * if `asana_logged` is eligible, so is `asana_pending` (because the
 * user might want to mark intent before completing).
 */
export function isChipEligible(
  kind: ChipKind,
  context: {
    chargeable_party_decision: string | null
    category_key: string | null
  },
): boolean {
  switch (kind) {
    case 'guest_notify_pending':
    case 'guest_notified':
      // Show when the cost is going to the guest, or when the category
      // explicitly says guest damage (chargeable may still be pending).
      return (
        context.chargeable_party_decision === 'guest' ||
        context.category_key === 'guest_damage'
      )

    case 'owner_notify_pending':
    case 'owner_notified':
      // Show when the owner is on the hook for the cost / the category
      // is explicitly owner-chargeable.
      return (
        context.chargeable_party_decision === 'owner' ||
        context.category_key === 'owner_chargeable'
      )

    case 'replacement_needed':
    case 'replaced':
      // Replacement is meaningful for inventory items AND for damaged
      // appliances (maintenance_issue) AND for guest-caused damage
      // (guest_damage). A cracked coffee machine flagged as
      // maintenance_issue legitimately may need replacement.
      return (
        context.category_key === 'inventory_missing' ||
        context.category_key === 'inventory_damaged' ||
        context.category_key === 'maintenance_issue' ||
        context.category_key === 'guest_damage'
      )

    case 'needs_reclean':
      // Reclean is for cleaning category specifically.
      return context.category_key === 'cleaning_issue'

    case 'asana_pending':
    case 'asana_logged':
    case 'maintenance_pending':
    case 'maintenance_assigned':
    case 'maintenance_done':
    case 'awaiting_owner_approval':
    case 'owner_approved':
      // Always available — every flag may end up needing Asana, a
      // maintenance job, or owner approval.
      return true

    default:
      return false
  }
}

/**
 * Convenience for the detail page: the ordered list of chips to show
 * for this flag's context. Stable order so the UI doesn't shift.
 */
export function eligibleChipKinds(context: {
  chargeable_party_decision: string | null
  category_key: string | null
}): ChipKind[] {
  return ALL_CHIP_KINDS.filter((k) => isChipEligible(k, context))
}
