import { describe, it, expect } from 'vitest'
import {
  evaluatePackSubmit,
  parseExpectedCount,
  type ExpectedCount,
} from '@/lib/packs/submit-guard'

const absent: ExpectedCount = { present: false }
const invalid: ExpectedCount = { present: true, valid: false }
const val = (value: number): ExpectedCount => ({ present: true, valid: true, value })

describe('parseExpectedCount', () => {
  it('treats a missing field (null) as ABSENT', () => {
    expect(parseExpectedCount(null)).toEqual({ present: false })
    expect(parseExpectedCount(undefined)).toEqual({ present: false })
  })

  it('parses a valid non-negative integer', () => {
    expect(parseExpectedCount('5')).toEqual({ present: true, valid: true, value: 5 })
    expect(parseExpectedCount('0')).toEqual({ present: true, valid: true, value: 0 })
  })

  it('treats a PRESENT-but-malformed value as invalid (not absent)', () => {
    for (const bad of ['', '   ', 'abc', '-2', '3.9', '1e3', 'NaN', '0x10', '  5x']) {
      expect(parseExpectedCount(bad)).toEqual({ present: true, valid: false })
    }
  })
})

describe('evaluatePackSubmit', () => {
  it('blocks zero linked photos (empty) regardless of expected', () => {
    expect(evaluatePackSubmit({ linkedActivePhotoCount: 0, expected: absent })).toMatchObject({
      ok: false,
      code: 'empty',
    })
    expect(evaluatePackSubmit({ linkedActivePhotoCount: 0, expected: val(0) })).toMatchObject({
      ok: false,
      code: 'empty',
    })
    expect(
      evaluatePackSubmit({ linkedActivePhotoCount: Number.NaN, expected: absent }),
    ).toMatchObject({ ok: false, code: 'empty' })
  })

  it('FAILS CLOSED on a present-but-malformed expected_count, even with photos', () => {
    const d = evaluatePackSubmit({ linkedActivePhotoCount: 5, expected: invalid })
    expect(d).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('FAILS CLOSED on an ABSENT expected_count (no legacy bypass), even with photos', () => {
    const d = evaluatePackSubmit({ linkedActivePhotoCount: 9, expected: absent })
    expect(d).toMatchObject({ ok: false, code: 'missing' })
  })

  it('blocks the partial race: intended 5, only 3 linked', () => {
    const d = evaluatePackSubmit({ linkedActivePhotoCount: 3, expected: val(5) })
    expect(d).toMatchObject({ ok: false, code: 'partial' })
    if (!d.ok) expect(d.message).toContain('3 of 5')
  })

  it('blocks 10 existing + 5 intended + only 3 new saved (linked 13 / intended 15)', () => {
    const d = evaluatePackSubmit({ linkedActivePhotoCount: 13, expected: val(15) })
    expect(d).toMatchObject({ ok: false, code: 'partial' })
    if (!d.ok) expect(d.message).toContain('13 of 15')
  })

  it('allows when linked meets or exceeds the intended total', () => {
    expect(evaluatePackSubmit({ linkedActivePhotoCount: 5, expected: val(5) })).toEqual({ ok: true })
    expect(evaluatePackSubmit({ linkedActivePhotoCount: 6, expected: val(5) })).toEqual({ ok: true })
  })

  it('an intended total of 0 with photos present is fine (>=1 already met)', () => {
    expect(evaluatePackSubmit({ linkedActivePhotoCount: 2, expected: val(0) })).toEqual({ ok: true })
  })
})
