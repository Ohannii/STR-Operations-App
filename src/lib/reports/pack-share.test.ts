import { describe, it, expect } from 'vitest'
import { bedroomLabel, buildPackShareNotes } from '@/lib/reports/pack-share'

describe('bedroomLabel', () => {
  it('uses singular for 1 and plural otherwise', () => {
    expect(bedroomLabel(1)).toBe('1 bedroom')
    expect(bedroomLabel(2)).toBe('2 bedrooms')
    expect(bedroomLabel(3)).toBe('3 bedrooms')
    expect(bedroomLabel(0)).toBe('0 bedrooms')
  })
  it('returns null (omit the line) when the count is absent', () => {
    expect(bedroomLabel(null)).toBeNull()
    expect(bedroomLabel(undefined)).toBeNull()
  })
  it('never renders "undefined bedrooms" (returns null for missing values)', () => {
    expect(bedroomLabel(undefined)).toBeNull()
    expect(bedroomLabel(null)).toBeNull()
  })
})

describe('buildPackShareNotes', () => {
  it('builds a bold PDF-referencing heading + ordered bullet list from captioned photos', () => {
    const out = buildPackShareNotes('Unit Nr - 95', [
      { caption: 'Fridge door has a small mark' },
      { caption: 'Bathroom towel rail is loose' },
    ])
    expect(out).toBe(
      '*📝 Notes for the pre-arrival report below — Unit Nr - 95*\n' +
        '• Photo 1: Fridge door has a small mark\n' +
        '• Photo 2: Bathroom towel rail is loose',
    )
  })

  it('bolds the complete heading with WhatsApp asterisk syntax (single opening/closing pair)', () => {
    const out = buildPackShareNotes('Test 1', [{ caption: 'First caption' }])
    const firstLine = out.split('\n')[0]
    expect(firstLine).toBe('*📝 Notes for the pre-arrival report below — Test 1*')
    expect(firstLine.startsWith('*')).toBe(true)
    expect(firstLine.endsWith('*')).toBe(true)
    // Exactly one asterisk pair wrapping the whole heading — no stray asterisks.
    expect((firstLine.match(/\*/g) ?? []).length).toBe(2)
  })

  it('omits blank/whitespace/undefined captions and numbers by report position', () => {
    const out = buildPackShareNotes('Unit A', [
      { caption: 'First note' }, // Photo 1
      { caption: '   ' }, // Photo 2 — blank, omitted
      { caption: null }, // Photo 3 — none, omitted
      { caption: 'Fourth note' }, // Photo 4
    ])
    expect(out).toContain('• Photo 1: First note')
    expect(out).toContain('• Photo 4: Fourth note')
    expect(out).not.toContain('Photo 2')
    expect(out).not.toContain('Photo 3')
    expect(out).not.toContain('undefined')
  })

  it('returns an empty string (PDF only, no heading-only message) when no photo has a caption', () => {
    const out = buildPackShareNotes('Unit B', [{ caption: null }, { caption: '' }])
    expect(out).toBe('')
  })

  it('returns an empty string for an empty photo list', () => {
    expect(buildPackShareNotes('Unit C', [])).toBe('')
  })

  it('preserves order', () => {
    // Distinctive captions that never appear in the heading text, so the
    // index assertions test bullet order (not incidental heading characters).
    const out = buildPackShareNotes('U', [
      { caption: 'zzz-one' },
      { caption: 'zzz-two' },
      { caption: 'zzz-three' },
    ])
    expect(out.indexOf('zzz-one')).toBeLessThan(out.indexOf('zzz-two'))
    expect(out.indexOf('zzz-two')).toBeLessThan(out.indexOf('zzz-three'))
  })
})
