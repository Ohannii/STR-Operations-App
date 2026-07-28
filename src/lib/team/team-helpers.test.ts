import { describe, it, expect } from 'vitest'
import { canonicalEmail, invitationStatus, isInvitableRole } from '@/lib/team/team-helpers'

describe('canonicalEmail', () => {
  it('trims and lowercases — the only comparable form', () => {
    expect(canonicalEmail('  Nichole@Drop-Inn.CO.ZA ')).toBe('nichole@drop-inn.co.za')
  })
})

describe('isInvitableRole — super_admin is NEVER grantable from company surfaces', () => {
  it('accepts the standard company roles', () => {
    for (const r of ['company_admin', 'inspector', 'ops_manager', 'gm']) {
      expect(isInvitableRole(r)).toBe(true)
    }
  })
  it('rejects super_admin and unknown keys', () => {
    expect(isInvitableRole('super_admin')).toBe(false)
    expect(isInvitableRole('root')).toBe(false)
    expect(isInvitableRole('')).toBe(false)
  })
})

describe('invitationStatus derivation (revoked > accepted > failed > expired > pending)', () => {
  const NOW = Date.parse('2026-07-23T12:00:00Z')
  const past = '2026-07-22T12:00:00Z'
  const future = '2026-07-30T12:00:00Z'

  it('covers every state with the documented precedence', () => {
    expect(
      invitationStatus({ revokedAt: past, acceptedAt: past, expiresAt: past, nowMs: NOW }),
    ).toBe('revoked')
    expect(
      invitationStatus({ revokedAt: null, acceptedAt: past, expiresAt: past, nowMs: NOW }),
    ).toBe('accepted')
    expect(
      invitationStatus({
        revokedAt: null,
        acceptedAt: null,
        expiresAt: future,
        failedReason: 'auth provisioning failed',
        nowMs: NOW,
      }),
    ).toBe('provisioning_failed')
    expect(
      invitationStatus({ revokedAt: null, acceptedAt: null, expiresAt: past, nowMs: NOW }),
    ).toBe('expired')
    expect(
      invitationStatus({ revokedAt: null, acceptedAt: null, expiresAt: future, nowMs: NOW }),
    ).toBe('pending')
  })
})

// safeInternalNext tests removed with the helper (rev 2): the confirm route
// no longer accepts a `next` parameter at all — fixed destinations only.
