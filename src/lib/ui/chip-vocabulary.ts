/**
 * Operational chip vocabulary — source of truth in app code.
 *
 * Mirrors docs/CHIP_VOCABULARY.md. Each chip kind has:
 *   - a stable string identifier (stored in flag_operational_marks.kind)
 *   - a display label (operator-grade English)
 *   - a Lucide icon
 *   - a Badge tone
 *   - optional `replaces`: kinds that should be auto-cleared when this
 *     one is set (predecessor chains, e.g., maintenance_pending →
 *     maintenance_assigned → maintenance_done).
 *
 * The eligibility logic (which chips show on which flags) lives here
 * too so the flag detail page and the Action Centre flag-card row
 * agree on the same rules.
 *
 * Adding a new chip kind: add to ChipKind union + ALL_CHIP_KINDS +
 * CHIP_MAP + (optionally) eligibility logic + docs/CHIP_VOCABULARY.md.
 * No database migration required — the `kind` column is plain text.
 */

import {
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Clock,
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
  | 'guest_notified'
  | 'owner_notified'
  | 'asana_logged'
  | 'maintenance_pending'
  | 'maintenance_assigned'
  | 'maintenance_done'
  | 'replaced'
  | 'awaiting_owner_approval'
  | 'owner_approved'
  | 'needs_reclean'

export const ALL_CHIP_KINDS: ChipKind[] = [
  'guest_notified',
  'owner_notified',
  'asana_logged',
  'maintenance_pending',
  'maintenance_assigned',
  'maintenance_done',
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
   * Example: setting `maintenance_assigned` clears
   * `maintenance_pending`. Setting `maintenance_done` clears both
   * pending and assigned.
   */
  replaces?: ChipKind[]
}

const CHIP_MAP: Record<ChipKind, ChipDisplay> = {
  guest_notified: {
    kind: 'guest_notified',
    label: 'Guest notified',
    tone: 'emerald',
    icon: UserCheck,
  },
  owner_notified: {
    kind: 'owner_notified',
    label: 'Owner notified',
    tone: 'emerald',
    icon: UserCheck,
  },
  asana_logged: {
    kind: 'asana_logged',
    label: 'Asana logged',
    tone: 'sky',
    icon: ClipboardCheck,
  },
  maintenance_pending: {
    kind: 'maintenance_pending',
    label: 'Maintenance pending',
    tone: 'amber',
    icon: Clock,
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
  replaced: {
    kind: 'replaced',
    label: 'Replaced',
    tone: 'emerald',
    icon: PackageCheck,
  },
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

/** Internal predicate used by both the detail toggle row and the
 *  Action Centre's compact chip row. Keeps the two surfaces aligned. */
export function isChipEligible(
  kind: ChipKind,
  context: {
    chargeable_party_decision: string | null
    category_key: string | null
  },
): boolean {
  switch (kind) {
    case 'guest_notified':
      // Show when the cost is going to the guest, or when the category
      // explicitly says guest damage (chargeable may still be pending).
      return (
        context.chargeable_party_decision === 'guest' ||
        context.category_key === 'guest_damage'
      )

    case 'owner_notified':
      // Show when the owner is on the hook for the cost / the category is
      // explicitly owner-chargeable.
      return (
        context.chargeable_party_decision === 'owner' ||
        context.category_key === 'owner_chargeable'
      )

    case 'replaced':
      // "Replaced" is meaningful for inventory items.
      return (
        context.category_key === 'inventory_missing' ||
        context.category_key === 'inventory_damaged'
      )

    case 'needs_reclean':
      // Reclean is for cleaning category specifically.
      return context.category_key === 'cleaning_issue'

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

/** Convenience for the detail page: the ordered list of chips to show
 *  for this flag's context. Stable order so the UI doesn't shift. */
export function eligibleChipKinds(context: {
  chargeable_party_decision: string | null
  category_key: string | null
}): ChipKind[] {
  return ALL_CHIP_KINDS.filter((k) => isChipEligible(k, context))
}
