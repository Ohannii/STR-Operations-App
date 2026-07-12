import { describe, it, expect } from 'vitest'
import {
  buildFlagForMapping,
  type OutboxFlagRow,
} from '@/lib/integrations/worker/build-flag-for-mapping'

function row(overrides: Partial<OutboxFlagRow> = {}): OutboxFlagRow {
  return {
    id: 'flag-1',
    description: 'Leaking tap',
    issueTitle: null,
    severity: 'med',
    status: 'raised',
    accountability: null,
    raisedAtIso: '2026-07-08T12:00:00Z',
    propertyId: 'prop-1',
    propertyName: 'Real Property',
    categoryKey: 'maintenance_issue',
    categoryLabel: 'Broken thing',
    reporterName: 'Quraisha R.',
    ...overrides,
  }
}

describe('buildFlagForMapping', () => {
  it('maps DB fields into the FlagForMapping shape', () => {
    const m = buildFlagForMapping(row(), {
      appBaseUrl: 'https://x.example',
      todayIso: '2026-07-08',
    })
    expect(m.id).toBe('flag-1')
    expect(m.description).toBe('Leaking tap')
    expect(m.severity).toBe('med')
    expect(m.categoryKey).toBe('maintenance_issue')
    expect(m.categoryLabel).toBe('Broken thing')
    expect(m.propertyName).toBe('Real Property')
    expect(m.propertyId).toBe('prop-1')
    expect(m.status).toBe('raised')
    expect(m.appBaseUrl).toBe('https://x.example')
    expect(m.todayIso).toBe('2026-07-08')
  })

  it('passes raw accountability through and derives a non-empty label', () => {
    const nullCase = buildFlagForMapping(row(), { appBaseUrl: 'https://x' })
    expect(nullCase.accountability).toBeNull()
    expect(typeof nullCase.accountabilityLabel).toBe('string')
    expect(nullCase.accountabilityLabel.length).toBeGreaterThan(0)

    const guestCase = buildFlagForMapping(row({ accountability: 'guest_damage' }), {
      appBaseUrl: 'https://x',
    })
    expect(guestCase.accountability).toBe('guest_damage')
    expect(guestCase.accountabilityLabel.length).toBeGreaterThan(0)
  })

  it('falls back the reporter name when missing', () => {
    const m = buildFlagForMapping(row({ reporterName: null }), { appBaseUrl: 'https://x' })
    expect(m.reporterName).toBe('Unknown')
  })

  it('passes issueTitle through (null becomes undefined)', () => {
    expect(
      buildFlagForMapping(row({ issueTitle: 'Broken pot' }), { appBaseUrl: 'https://x' })
        .issueTitle,
    ).toBe('Broken pot')
    expect(
      buildFlagForMapping(row({ issueTitle: null }), { appBaseUrl: 'https://x' }).issueTitle,
    ).toBeUndefined()
  })
})
