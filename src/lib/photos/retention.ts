/**
 * Photo retention class — derived automatically from where the
 * camera was opened. The inspector never picks one.
 *
 * Spec source: docs/EVIDENCE_CAMERA_AND_PHOTO_NOTES.md, table
 * "Photo retention class — derived automatically", and
 * docs/PHOTO_RETENTION_POLICY.md.
 *
 * For Session 8 we cover two surfaces:
 *   - Flag card (any flag type) → derived from flag category
 *   - Pre-arrival evidence pack on the Action Centre → routine_pre_arrival
 *
 * Promotion is one-way: routine → dispute possible; never reverse.
 * Promotion logic itself ships in a later session — for now we just
 * write the correct class at capture time so promotion is a simple
 * column update later.
 */

import type { FlagCategoryKey } from '@/lib/ui/flag-category'

export type RetentionClass =
  | 'routine_pre_arrival'
  | 'routine_post_stay'
  | 'dispute_evidence'
  | 'owner_chargeable_evidence'
  | 'annual_audit_evidence'
  | 'maintenance_before_after'
  | 'inventory_evidence'

/**
 * Pick the retention class for a photo attached to a flag.
 * Derived from the flag's category key.
 */
export function retentionClassForFlagCategory(
  categoryKey: FlagCategoryKey | string | null,
): RetentionClass {
  switch (categoryKey) {
    case 'guest_damage':
      // Guest-caused damage feeds the OTA dispute pipeline; treat as
      // dispute evidence from day 1 so it survives routine purges.
      return 'dispute_evidence'

    case 'maintenance_issue':
      return 'maintenance_before_after'

    case 'inventory_missing':
    case 'inventory_damaged':
      return 'inventory_evidence'

    case 'safety_urgent':
      // Safety is high-priority and may end up in disputes or
      // insurance — keep on the dispute track.
      return 'dispute_evidence'

    case 'owner_chargeable':
      return 'owner_chargeable_evidence'

    case 'cleaning_issue':
    case 'condition_note':
    case 'follow_up_required':
    case 'company_responsibility':
    case 'no_action_record':
    default:
      // No special-evidence flavour. Treat as routine-post-stay so
      // it lives the operational window only.
      return 'routine_post_stay'
  }
}

/** Retention class for a pre-arrival evidence pack capture. */
export const PRE_ARRIVAL_RETENTION: RetentionClass = 'routine_pre_arrival'
