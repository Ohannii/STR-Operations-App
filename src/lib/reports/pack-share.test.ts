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
  it('builds a header + ordered bullet list from captioned photos', () => {
    const out = buildPackShareNotes('Unit Nr - 95', [
      { caption: 'Fridge door has a small mark' },
      { caption: 'Bathroom towel rail is loose' },
    ])
    expect(out).toBe(
      'Pre-arrival report — Unit Nr - 95\nPhoto notes:\n' +
        '• Photo 1: Fridge door has a small mark\n' +
        '• Photo 2: Bathroom towel rail is loose',
    )
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

  it('returns just the header when no photo has a caption', () => {
    const out = buildPackShareNotes('Unit B', [{ caption: null }, { caption: '' }])
    expect(out).toBe('Pre-arrival report — Unit B')
    expect(out).not.toContain('Photo notes')
  })

  it('preserves order', () => {
    const out = buildPackShareNotes('U', [{ caption: 'a' }, { caption: 'b' }, { caption: 'c' }])
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'))
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('c'))
  })
})
