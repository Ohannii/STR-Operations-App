/**
 * Maps a property.status value (see core_schema.sql) to a display
 * label + a Badge tone for semantic color.
 *
 * Source values come from the properties.status text field with
 * the documented set of allowed values:
 *   'idle' | 'guest_in' | 'between_stays' |
 *   'pre_arrival_pending' | 'post_stay_pending' |
 *   'needs_attention' | 'critical' |
 *   'ready_for_arrival' | 'not_ready'
 */

import type { BadgeTone } from '@/components/ui/badge'

type Known =
  | 'idle'
  | 'guest_in'
  | 'between_stays'
  | 'pre_arrival_pending'
  | 'post_stay_pending'
  | 'needs_attention'
  | 'critical'
  | 'ready_for_arrival'
  | 'not_ready'

const MAP: Record<Known, { tone: BadgeTone; label: string }> = {
  idle: { tone: 'slate', label: 'Idle' },
  guest_in: { tone: 'blue', label: 'Guest in' },
  between_stays: { tone: 'amber', label: 'Between stays' },
  pre_arrival_pending: { tone: 'amber', label: 'Pre-arrival pending' },
  post_stay_pending: { tone: 'amber', label: 'Post-stay pending' },
  needs_attention: { tone: 'orange', label: 'Needs attention' },
  critical: { tone: 'red', label: 'Critical' },
  ready_for_arrival: { tone: 'emerald', label: 'Ready for arrival' },
  not_ready: { tone: 'red', label: 'Not ready' },
}

export function propertyStatusDisplay(status: string): { tone: BadgeTone; label: string } {
  if (status in MAP) {
    return MAP[status as Known]
  }
  return { tone: 'slate', label: status }
}
