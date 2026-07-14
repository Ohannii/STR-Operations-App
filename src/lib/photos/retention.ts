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
  // Session 9A Slice 1: security/access events (key handovers, lock
  // changes) are never routine. New class; photos.retention_class is
  // unconstrained text, so this is a code-only addition.
  | 'security_access_evidence'

/**
 * Session 9A Slice 1: retention is derived from category + accountability
 * (+ an optional open-dispute signal), not category alone. Precedence is
 * evaluated top-to-bottom (first match wins) and is promote-only — it may
 * upgrade toward dispute-grade but must never downgrade.
 *
 * Transition safety: existing flags still carry the LEGACY category keys
 * `guest_damage` / `owner_chargeable` / `company_responsibility` (the
 * planned re-seed/back-fill has not run). Those legacy category keys are
 * handled here so no existing evidence is under-retained before back-fill.
 *
 * LOCKSTEP: the finalize_flag_with_photos RPC derives retention in SQL
 * (public.derive_photo_retention_class, migration
 * 20260712120000_finalize_flag_with_photos.sql) because that function is
 * directly callable by authenticated users and must not trust a
 * client-supplied class. Keep the SQL CASE and this function in sync
 * (the SQL omits hasOpenDispute, which is always false at creation time).
 */
export function deriveRetentionClass(input: {
  categoryKey: FlagCategoryKey | string | null | undefined
  accountability?: string | null
  /** True when linked to an open dispute / recovery / claim / accountability record. */
  hasOpenDispute?: boolean
}): RetentionClass {
  const cat = input.categoryKey ?? ''
  const acc = input.accountability ?? ''

  // 1. Active dispute / recovery / claim / accountability link.
  if (input.hasOpenDispute) return 'dispute_evidence'
  // 2. Accountability = guest damage (current or legacy `guest`).
  if (acc === 'guest_damage' || acc === 'guest') return 'dispute_evidence'
  // 3. Accountability = owner chargeable (current or legacy `owner`).
  if (acc === 'owner_chargeable' || acc === 'owner') return 'owner_chargeable_evidence'
  // 4. Safety category — insurance / legal / safety track.
  if (cat === 'safety_urgent' || cat === 'safety') return 'dispute_evidence'
  // 4b. Legacy accountability-as-category rows (pre back-fill).
  if (cat === 'guest_damage') return 'dispute_evidence'
  if (cat === 'owner_chargeable') return 'owner_chargeable_evidence'
  // 5. Access / keys / lock — security/access evidence, never routine.
  if (cat === 'access_keys_lock' || cat === 'access_keys') return 'security_access_evidence'
  // 6. Maintenance or appliance/furniture — asset & maintenance evidence.
  if (cat === 'maintenance_issue' || cat === 'appliance_furniture') return 'maintenance_before_after'
  // 7. Item missing / damaged — inventory accountability.
  if (cat === 'inventory_missing' || cat === 'inventory_damaged') return 'inventory_evidence'
  // 8. Everything else (cleaning, linen, observation/note; non-dispute) —
  //    operational window only. (Pre-arrival pack captures use
  //    PRE_ARRIVAL_RETENTION, set by the caller, not this function.)
  return 'routine_post_stay'
}

/**
 * Back-compat wrapper: category-only derivation. Prefer
 * deriveRetentionClass() with accountability where available.
 */
export function retentionClassForFlagCategory(
  categoryKey: FlagCategoryKey | string | null,
): RetentionClass {
  return deriveRetentionClass({ categoryKey })
}

/** Retention class for a pre-arrival evidence pack capture. */
export const PRE_ARRIVAL_RETENTION: RetentionClass = 'routine_pre_arrival'
