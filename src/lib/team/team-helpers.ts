/**
 * Pure helpers for PR-A: company team management + safe invitations.
 * Kept pure so authority rules and status derivation are unit-testable
 * without any I/O.
 */

/** Canonical email: trim + lowercase. The ONLY form ever compared/stored. */
export function canonicalEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Roles a company_admin may grant through the Team page.
 * super_admin is PLATFORM-level and must never be grantable from any
 * company-facing surface — excluded here AND re-checked in the database
 * function (client lists are not authorization).
 */
export const INVITABLE_ROLE_KEYS = [
  'company_admin',
  'gm',
  'ops_manager',
  'maintenance_coordinator',
  'inspector',
  'maintenance_tech',
  'inventory_manager',
  'finance',
  'auditor',
  'property_owner_viewer',
] as const

export type InvitableRoleKey = (typeof INVITABLE_ROLE_KEYS)[number]

export function isInvitableRole(roleKey: string): roleKey is InvitableRoleKey {
  return (INVITABLE_ROLE_KEYS as readonly string[]).includes(roleKey)
}

/**
 * Invitation lifecycle, derived from timestamps — one source of truth.
 * Order matters: revoked wins over accepted wins over expired.
 */
export type InvitationStatus =
  | 'revoked'
  | 'accepted'
  | 'expired'
  | 'provisioning_failed'
  | 'pending'

export function invitationStatus(row: {
  revokedAt: string | null
  acceptedAt: string | null
  expiresAt: string | null
  failedReason?: string | null
  nowMs?: number
}): InvitationStatus {
  if (row.revokedAt) return 'revoked'
  if (row.acceptedAt) return 'accepted'
  if (row.failedReason) return 'provisioning_failed'
  const now = row.nowMs ?? Date.now()
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now) return 'expired'
  return 'pending'
}

// NOTE (rev 2): safeInternalNext was removed together with the confirm
// route's `next` parameter — the route now uses FIXED destinations only
// (claimed -> /invite/set-password, already_member -> /dashboard), which is
// strictly stronger than validating arbitrary next values.
