/**
 * Maps a flag_categories.key (the 11 system taxonomy rows seeded
 * in migration 0004) to display data used by the UI.
 *
 * Two sets of copy:
 *   - `label` + `blurb`  — used everywhere the category surfaces
 *     in the app (flag cards, form dropdown, etc.). Operator-grade
 *     plain English, not playful.
 *   - `tileLabel` + `tileSubtitle` — used ONLY on the quick-add
 *     tiles on the Apartment Action Centre, where one tile may
 *     collectively represent more than one underlying category
 *     (the "Inventory" tile covers both missing AND damaged; the
 *     specific category gets re-picked on the form).
 *
 * Source of truth for icon names + general meaning is
 * docs/FLAG_AND_ACTION_MODEL.md. Severity defaults mirror the
 * seeded flag_categories.severity_default column so the raise-flag
 * form can pre-select without an extra DB round-trip.
 *
 * QUICK_ADD_KEYS is the ordered list of flag types shown as
 * single-tap tiles. Six tiles because that fits one row on most
 * screens and covers the most common inspector flows. Other
 * categories remain selectable in the raise-flag form's dropdown.
 */

import {
  AlertOctagon,
  Bookmark,
  Building2,
  CalendarClock,
  CircleOff,
  ClipboardList,
  Search,
  Sparkles,
  UserX,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from '@/components/ui/badge'

export type FlagCategoryKey =
  | 'condition_note'
  | 'cleaning_issue'
  | 'maintenance_issue'
  | 'inventory_missing'
  | 'inventory_damaged'
  | 'guest_damage'
  | 'owner_chargeable'
  | 'company_responsibility'
  | 'safety_urgent'
  | 'follow_up_required'
  | 'no_action_record'

export type FlagSeverity = 'low' | 'med' | 'high'

export type FlagCategoryDisplay = {
  key: FlagCategoryKey
  /** Used on flag cards and the form dropdown. */
  label: string
  /** Longer description for form hints / accessibility. */
  blurb: string
  /** Optional override for the Action Centre quick-add tile title. */
  tileLabel?: string
  /** Optional override for the Action Centre quick-add tile subtitle. */
  tileSubtitle?: string
  icon: LucideIcon
  tone: BadgeTone
  severityDefault: FlagSeverity
}

const MAP: Record<FlagCategoryKey, FlagCategoryDisplay> = {
  condition_note: {
    key: 'condition_note',
    label: 'Note',
    blurb: 'A status note worth recording, not an issue to action.',
    tileLabel: 'Note',
    tileSubtitle: 'General condition note',
    icon: ClipboardList,
    tone: 'slate',
    severityDefault: 'low',
  },
  cleaning_issue: {
    key: 'cleaning_issue',
    label: 'Cleaning',
    blurb: 'Needs cleaning beyond normal turnover.',
    tileLabel: 'Cleaning',
    tileSubtitle: 'Needs extra cleaning',
    icon: Sparkles,
    tone: 'sky',
    severityDefault: 'low',
  },
  maintenance_issue: {
    key: 'maintenance_issue',
    label: 'Maintenance',
    blurb: 'Something is broken, worn, or not working.',
    tileLabel: 'Maintenance',
    tileSubtitle: 'Broken, worn, or not working',
    icon: Wrench,
    tone: 'amber',
    severityDefault: 'med',
  },
  inventory_missing: {
    key: 'inventory_missing',
    label: 'Item missing',
    blurb: 'An item that should be here is not.',
    // The Inventory quick-add tile collectively represents both
    // missing and damaged. The form lets the user re-pick.
    tileLabel: 'Inventory',
    tileSubtitle: 'Missing or damaged item',
    icon: Search,
    tone: 'amber',
    severityDefault: 'med',
  },
  inventory_damaged: {
    key: 'inventory_damaged',
    label: 'Item damaged',
    blurb: 'Item is present but broken.',
    icon: CircleOff,
    tone: 'amber',
    severityDefault: 'med',
  },
  guest_damage: {
    key: 'guest_damage',
    label: 'Guest damage',
    blurb: 'Damage that looks caused by the most recent guest.',
    tileLabel: 'Damage',
    tileSubtitle: 'Guest-caused damage',
    icon: UserX,
    tone: 'orange',
    severityDefault: 'high',
  },
  owner_chargeable: {
    key: 'owner_chargeable',
    label: 'Owner-chargeable',
    blurb: 'Wear, age, or owner responsibility — chargeable to owner.',
    icon: Wallet,
    tone: 'slate',
    severityDefault: 'low',
  },
  company_responsibility: {
    key: 'company_responsibility',
    label: 'Company-absorbed',
    blurb: 'Company absorbs this — staff error, gesture, etc.',
    icon: Building2,
    tone: 'slate',
    severityDefault: 'low',
  },
  safety_urgent: {
    key: 'safety_urgent',
    label: 'Safety',
    blurb: 'Smoke alarm, gas, lock, electrical, water leak. Same-day priority.',
    tileLabel: 'Safety',
    tileSubtitle: 'Same-day priority',
    icon: AlertOctagon,
    tone: 'red',
    severityDefault: 'high',
  },
  follow_up_required: {
    key: 'follow_up_required',
    label: 'Follow-up',
    blurb: 'Not actionable now; check again next inspection.',
    icon: CalendarClock,
    tone: 'slate',
    severityDefault: 'low',
  },
  no_action_record: {
    key: 'no_action_record',
    label: 'Record only',
    blurb: 'Recorded for history. No follow-up needed.',
    icon: Bookmark,
    tone: 'slate',
    severityDefault: 'low',
  },
}

export function getFlagCategoryDisplay(key: string): FlagCategoryDisplay | undefined {
  if ((Object.keys(MAP) as FlagCategoryKey[]).includes(key as FlagCategoryKey)) {
    return MAP[key as FlagCategoryKey]
  }
  return undefined
}

export function listFlagCategoryDisplays(): FlagCategoryDisplay[] {
  return Object.values(MAP)
}

/**
 * Ordered list of categories shown as quick-add tiles on the
 * Apartment Action Centre. Six tiles, ordered for legibility:
 * maintenance / damage / inventory / cleaning / safety / note.
 * Safety sits at position 5 so it's visually distinct (red) and
 * still in the top row on six-column layouts.
 */
export const QUICK_ADD_KEYS: FlagCategoryKey[] = [
  'maintenance_issue',
  'guest_damage',
  'inventory_missing',
  'cleaning_issue',
  'safety_urgent',
  'condition_note',
]

const SEVERITY_LABEL: Record<FlagSeverity, string> = {
  low: 'Low',
  med: 'Medium',
  high: 'High',
}

const SEVERITY_TONE: Record<FlagSeverity, BadgeTone> = {
  low: 'slate',
  med: 'amber',
  high: 'red',
}

export function severityDisplay(severity: string): { label: string; tone: BadgeTone } {
  if (severity === 'low' || severity === 'med' || severity === 'high') {
    return { label: SEVERITY_LABEL[severity], tone: SEVERITY_TONE[severity] }
  }
  return { label: severity, tone: 'slate' }
}

// ============================================================
// Flag category groups for the Action Centre layout (Session 7)
// ============================================================
//
// The Action Centre groups open flags into collapsible category
// sections (Replit-style). Several underlying flag_categories can
// share one display group — e.g., inventory_missing and
// inventory_damaged both land in "Inventory"; condition_note,
// no_action_record, and follow_up_required all land in "Notes /
// Record-only".
//
// Groups appear in the listed order. A group is hidden entirely
// when it has zero flags in scope (UI doesn't render an empty
// "Inventory (0)" header).

export type FlagCategoryGroup = {
  id: string
  label: string
  keys: FlagCategoryKey[]
}

export const FLAG_CATEGORY_GROUPS: FlagCategoryGroup[] = [
  { id: 'damage',          label: 'Damage',              keys: ['guest_damage'] },
  { id: 'maintenance',     label: 'Maintenance',         keys: ['maintenance_issue'] },
  { id: 'inventory',       label: 'Inventory',           keys: ['inventory_missing', 'inventory_damaged'] },
  { id: 'cleaning',        label: 'Cleaning',            keys: ['cleaning_issue'] },
  { id: 'safety',          label: 'Safety',              keys: ['safety_urgent'] },
  { id: 'owner_chargeable',label: 'Owner-chargeable',    keys: ['owner_chargeable', 'company_responsibility'] },
  { id: 'notes',           label: 'Notes / Record-only', keys: ['condition_note', 'no_action_record', 'follow_up_required'] },
]

/**
 * Given a flag_categories.key, return the display group id it lives
 * in, or null if it doesn't map to any known group. Used by the
 * Action Centre's category-grouping logic.
 */
export function flagCategoryGroupId(categoryKey: string): string | null {
  for (const group of FLAG_CATEGORY_GROUPS) {
    if (group.keys.includes(categoryKey as FlagCategoryKey)) {
      return group.id
    }
  }
  return null
}
