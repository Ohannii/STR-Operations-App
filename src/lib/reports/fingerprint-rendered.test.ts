import { describe, it, expect } from 'vitest'
import { flagContentHash, type FlagFingerprintInput } from '@/lib/reports/report-paths'

/**
 * Slice 11C2 acceptance: every field the flag PDF RENDERS must be part of
 * the content fingerprint, so a change re-arms the attach event and the
 * existing content-hash artifact is never served stale.
 *
 * The flag PDF renders: issue title, category, severity, status,
 * responsibility (chargeable party), raised, closed, description, close
 * reason, and the ordered photos. It deliberately does NOT render internal
 * notes / audit rows, so those correctly do not affect the hash.
 */
function base(overrides: Partial<FlagFingerprintInput> = {}): FlagFingerprintInput {
  return {
    status: 'raised',
    severity: 'high',
    issueTitle: 'Broken pot',
    description: 'Cracked tile',
    chargeableParty: 'guest_damage',
    noActionReason: null,
    categoryKey: 'maintenance_issue',
    raisedAt: '2026-07-16T10:00:00Z',
    raisedBy: 'user-1',
    closedAt: null,
    photos: [
      { id: 'p1', storagePath: 'a/1.jpg', capturedAt: '2026-07-16T10:00:00Z', uploadedAt: '2026-07-16T10:01:00Z', notes: null, width: 1600, height: 1200 },
    ],
    ...overrides,
  }
}

describe('flagContentHash covers every rendered field', () => {
  const h0 = flagContentHash(base())
  const cases: [string, Partial<FlagFingerprintInput>][] = [
    ['status', { status: 'classified' }],
    ['severity', { severity: 'low' }],
    ['issueTitle', { issueTitle: 'Different title' }],
    ['description', { description: 'New description' }],
    ['chargeableParty (responsibility)', { chargeableParty: 'owner_chargeable' }],
    ['noActionReason (close reason)', { noActionReason: 'duplicate' }],
    ['categoryKey', { categoryKey: 'cleaning_issue' }],
    ['closedAt', { closedAt: '2026-07-18T09:00:00Z' }],
  ]

  for (const [label, override] of cases) {
    it(`changes the hash when ${label} changes`, () => {
      expect(flagContentHash(base(override))).not.toBe(h0)
    })
  }

  it('changes when a follow-up photo is appended', () => {
    const withPhoto = base({
      photos: [
        ...base().photos,
        { id: 'p2', storagePath: 'a/2.jpg', capturedAt: '2026-07-18T12:00:00Z', uploadedAt: '2026-07-18T12:01:00Z', notes: null, width: 1600, height: 1200 },
      ],
    })
    expect(flagContentHash(withPhoto)).not.toBe(h0)
  })

  it('is stable when nothing rendered changes', () => {
    expect(flagContentHash(base())).toBe(h0)
  })
})
