/**
 * Maps a flag_categories.key (the 11 system taxonomy rows seeded
 * in migration 0004) to display data used by the UI: a 3-word
 * stupid-proof label, an icon, and a Badge tone for color.
 *
 * Source of truth for icon names + labels is
 * docs/FLAG_AND_ACTION_MODEL.md. Severity defaults come from the
 * seeded flag_categories.severity_default column; we mirror them
 * here for use in form pre-selection so we don't need an extra DB
 * round-trip before rendering the "raise flag" page.
 *
 * QUICK_ADD_KEYS is the ordered list of flag types shown as
 * single-tap tiles on the Apartment Action Centre. Six tiles
 * because that fits one row on most screens and covers the most
 * common inspector flows. Other categories (owner-chargeable,
 * follow-up, etc.) remain selectable on the raise-flag form.
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
  label: string
  icon: LucideIcon
  tone: BadgeTone
  severityDefault: FlagSeverity
  blurb: string
}

const MAP: Record<FlagCategoryKey, FlagCategoryDisplay> = {
  condition_note: {
    key: 'condition_note',
    label: 'Just a note',
    icon: ClipboardList,
    tone: 'slate',
    severityDefault: 'low',
    blurb: 'A status note worth recording, not an issue to action.',
  },
  cleaning_issue: {
    key: 'cleaning_issue',
    label: 'Cleaning needed',
    icon: Sparkles,
    tone: 'sky',
    severityDefault: 'low',
    blurb: 'Needs cleaning beyond normal turnover.',
  },
  maintenance_issue: {
    key: 'maintenance_issue',
    label: 'Broken thing',
    icon: Wrench,
    tone: 'amber',
    severityDefault: 'med',
    blurb: 'Something is broken or worn out.',
  },
  inventory_missing: {
    key: 'inventory_missing',
    label: 'Item missing',
    icon: Search,
    tone: 'amber',
    severityDefault: 'med',
    blurb: 'An item that should be here is not.',
  },
  inventory_damaged: {
    key: 'inventory_damaged',
    label: 'Item damaged',
    icon: CircleOff,
    tone: 'amber',
    severityDefault: 'med',
    blurb: 'Item is here but broken.',
  },
  guest_damage: {
    key: 'guest_damage',
    label: 'Guest broke it',
    icon: UserX,
    tone: 'orange',
    severityDefault: 'high',
    blurb: 'Damage that looks caused by the most recent guest.',
  },
  owner_chargeable: {
    key: 'owner_chargeable',
    label: 'Owner pays',
    icon: Wallet,
    tone: 'slate',
    severityDefault: 'low',
    blurb: 'Wear, age, or owner responsibility — chargeable to owner.',
  },
  company_responsibility: {
    key: 'company_responsibility',
    label: 'Company pays',
    icon: Building2,
    tone: 'slate',
    severityDefault: 'low',
    blurb: 'Company absorbs this — staff error, gesture, etc.',
  },
  safety_urgent: {
    key: 'safety_urgent',
    label: 'Safety!',
    icon: AlertOctagon,
    tone: 'red',
    severityDefault: 'high',
    blurb: 'Smoke alarm, gas, lock, electrical, water leak. Same-day priority.',
  },
  follow_up_required: {
    key: 'follow_up_required',
    label: 'Check next time',
    icon: CalendarClock,
    tone: 'slate',
    severityDefault: 'low',
    blurb: 'Not actionable now; check again next inspection.',
  },
  no_action_record: {
    key: 'no_action_record',
    label: 'Just noting it',
    icon: Bookmark,
    tone: 'slate',
    severityDefault: 'low',
    blurb: 'Recorded for history. No follow-up needed.',
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
 * maintenance / guest damage / inventory / cleaning / safety / note.
 * Safety sits at the end so it's visually distinct (red).
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
