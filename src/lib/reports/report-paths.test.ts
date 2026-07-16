import { describe, it, expect } from 'vitest'
import {
  flagContentHash,
  flagReportObjectPath,
  packReportObjectPath,
  safeAsciiFilename,
  flagShareFilename,
  TEMPLATE_VERSION,
  type FlagFingerprintInput,
} from '@/lib/reports/report-paths'

function baseFlag(overrides: Partial<FlagFingerprintInput> = {}): FlagFingerprintInput {
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

describe('flagContentHash', () => {
  it('is deterministic for identical content', () => {
    expect(flagContentHash(baseFlag())).toBe(flagContentHash(baseFlag()))
  })

  it('changes when a report-relevant field changes', () => {
    const a = flagContentHash(baseFlag())
    const b = flagContentHash(baseFlag({ chargeableParty: 'owner_chargeable' }))
    expect(a).not.toBe(b)
  })

  it('changes when a follow-up photo is appended', () => {
    const a = flagContentHash(baseFlag())
    const b = flagContentHash(
      baseFlag({
        photos: [
          ...baseFlag().photos,
          { id: 'p2', storagePath: 'a/2.jpg', capturedAt: '2026-07-16T12:00:00Z', uploadedAt: '2026-07-16T12:01:00Z', notes: null, width: 1600, height: 1200 },
        ],
      }),
    )
    expect(a).not.toBe(b)
  })

  it('changes when photo order changes', () => {
    const two = baseFlag({
      photos: [
        { id: 'p1', storagePath: 'a/1.jpg', capturedAt: null, uploadedAt: null, notes: null, width: null, height: null },
        { id: 'p2', storagePath: 'a/2.jpg', capturedAt: null, uploadedAt: null, notes: null, width: null, height: null },
      ],
    })
    const swapped = baseFlag({ photos: [two.photos[1], two.photos[0]] })
    expect(flagContentHash(two)).not.toBe(flagContentHash(swapped))
  })

  it('produces a 16-char hex hash', () => {
    expect(flagContentHash(baseFlag())).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('object paths', () => {
  it('flag path embeds template version + content hash', () => {
    const h = flagContentHash(baseFlag())
    expect(flagReportObjectPath('co1', 'f1', h)).toBe(
      `companies/co1/flags/f1/flag-report-t${TEMPLATE_VERSION}-${h}.pdf`,
    )
  })
  it('pack path is stable (template only)', () => {
    expect(packReportObjectPath('co1', 'pk1')).toBe(
      `companies/co1/packs/pk1/pack-report-t${TEMPLATE_VERSION}.pdf`,
    )
  })
})

describe('safeAsciiFilename', () => {
  it('converts em dashes and strips non-ASCII', () => {
    const out = safeAsciiFilename('Flag — Café résumé 你好')
    expect(out).not.toContain('—')
    expect(out).toMatch(/^[\x20-\x7E]+$/)
    expect(out.endsWith('.pdf')).toBe(true)
  })
  it('replaces filesystem-unsafe characters', () => {
    const out = safeAsciiFilename('a/b\\c:d*e?f"g<h>i|j')
    expect(out).not.toMatch(/[/\\?%*:|"<>]/)
  })
  it('length-limits and always ends in .pdf', () => {
    const out = safeAsciiFilename('x'.repeat(400))
    expect(out.length).toBeLessThanOrEqual(124)
    expect(out.endsWith('.pdf')).toBe(true)
  })
  it('falls back to report.pdf for empty/garbage input', () => {
    expect(safeAsciiFilename('你好')).toBe('report.pdf')
  })
  it('flagShareFilename is ascii + .pdf', () => {
    const out = flagShareFilename('FR-ABCD1234', 'Unit 12 — Sea View', '2026-07-16')
    expect(out).toMatch(/^[\x20-\x7E]+\.pdf$/)
  })
})
