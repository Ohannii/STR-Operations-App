import { describe, it, expect } from 'vitest'
import {
  formatReportDateSAST,
  formatReportDateTimeSAST,
  isAutoPackTitle,
  packDateDisplay,
} from '@/lib/reports/pack-dates'

/**
 * Pre-arrival packs are dated by SUBMISSION (South Africa time), the
 * draft-creation default title is replaced for display, custom titles are
 * kept, and missing times are never invented. Timestamps below are the
 * real stored values for the acceptance pack.
 */

// Nichole's Unit 75 pack 4c28e0c5-c40a-484e-b38a-3e6d3b3bf747.
const UNIT75 = {
  status: 'submitted',
  title: 'Pre-arrival pack — 29 Oct 2026, 09:20',
  startedAt: '2026-10-29T07:20:33.968014+00:00',
  submittedAt: '2026-11-03T14:02:56.438344+00:00',
}

describe('acceptance: Unit 75 (draft 29 Oct, submitted 3 Nov)', () => {
  const d = packDateDisplay(UNIT75)
  it('main date is the SUBMISSION date', () => {
    expect(d.mainDate).toBe('3 Nov 2026')
    expect(d.heading).toBe('Pre-arrival pack — 3 Nov 2026')
  })
  it('shows "Submitted 3 Nov 2026, 16:02" and "Draft created 29 Oct 2026, 09:20"', () => {
    expect(d.submittedLine).toBe('Submitted 3 Nov 2026, 16:02')
    expect(d.submittedAtText).toBe('3 Nov 2026, 16:02')
    expect(d.draftCreatedLine).toBe('Draft created 29 Oct 2026, 09:20')
    expect(d.draftCreatedOnOtherDay).toBe(true)
  })
  it('the stored 29 Oct title is recognised as the auto default (not a custom title)', () => {
    expect(d.customTitle).toBeNull()
    expect(d.heading).not.toContain('29 Oct')
  })
  it('report date (share filename) = submission time, unchanged', () => {
    expect(d.reportDateIso).toBe(new Date(UNIT75.submittedAt).toISOString())
  })
})

describe('same-day pack', () => {
  it('same South Africa day: dated by submission, no separate draft-day line needed', () => {
    const d = packDateDisplay({
      status: 'submitted',
      title: 'Pre-arrival pack — 03 Nov 2026, 15:09',
      startedAt: '2026-11-03T13:09:54Z',
      submittedAt: '2026-11-03T13:20:10Z',
    })
    expect(d.heading).toBe('Pre-arrival pack — 3 Nov 2026')
    expect(d.submittedLine).toBe('Submitted 3 Nov 2026, 15:20')
    expect(d.draftCreatedLine).toBe('Draft created 3 Nov 2026, 15:09')
    expect(d.draftCreatedOnOtherDay).toBe(false)
  })
})

describe('UTC timestamp that is already the NEXT day in South Africa', () => {
  it('22:30 UTC on 3 Nov is 00:30 on 4 Nov in South Africa', () => {
    const d = packDateDisplay({
      status: 'submitted',
      title: 'Pre-arrival pack — 03 Nov 2026, 23:40',
      startedAt: '2026-11-03T21:40:00Z',
      submittedAt: '2026-11-03T22:30:00Z',
    })
    expect(d.mainDate).toBe('4 Nov 2026')
    expect(d.submittedLine).toBe('Submitted 4 Nov 2026, 00:30')
    expect(d.draftCreatedLine).toBe('Draft created 3 Nov 2026, 23:40')
    expect(d.draftCreatedOnOtherDay).toBe(true)
  })
  it('21:59:59 UTC is still the same day (23:59)', () => {
    expect(formatReportDateTimeSAST('2026-11-03T21:59:59Z')).toBe('3 Nov 2026, 23:59')
    expect(formatReportDateTimeSAST('2026-11-03T22:00:00Z')).toBe('4 Nov 2026, 00:00')
  })
  it('year boundary', () => {
    expect(formatReportDateSAST('2026-12-31T22:15:00Z')).toBe('1 Jan 2027')
  })
})

describe('custom titles are kept exactly', () => {
  it.each([
    'Pre-arrival pack — 28 Oct 2026, 10:16 — corrected to Unit 98',
    'Legacy pre-arrival evidence',
    'Owner walk-through',
  ])('%s', (title) => {
    const d = packDateDisplay({
      status: 'submitted',
      title,
      startedAt: '2026-10-28T08:16:05Z',
      submittedAt: '2026-10-30T09:00:00Z',
    })
    expect(d.customTitle).toBe(title)
    expect(d.heading).toBe(title)
    // the submission date is still shown alongside
    expect(d.mainDate).toBe('30 Oct 2026')
    expect(d.submittedLine).toBe('Submitted 30 Oct 2026, 11:00')
  })

  it('an auto-looking title for a DIFFERENT time is treated as custom', () => {
    expect(isAutoPackTitle('Pre-arrival pack — 01 Oct 2026, 09:20', '2026-10-29T07:20:33Z')).toBe(false)
  })
})

describe('auto-title recognition (every default format ever written)', () => {
  it.each([
    ['Pre-arrival pack — 29 Oct 2026, 09:20', '2026-10-29T07:20:33.968Z'],
    ['Pre-arrival pack — 25 Sept 2026, 13:41', '2026-09-25T11:41:58.682Z'],
    ['Pre-arrival pack — 2026/06/01, 20:50', '2026-06-01T18:50:36.334Z'],
    ['Pre-arrival pack — 06/20/2026, 01:59 PM', '2026-06-20T13:59:00.970Z'], // early UTC-rendered title
    ['Pre-arrival pack — 29 Oct 2026, 09:20', '2026-10-29T07:21:00.400Z'], // minute boundary
  ])('%s (started %s)', (title, startedAt) => {
    expect(isAutoPackTitle(title, startedAt)).toBe(true)
  })
  it.each([[null], [''], ['Pre-arrival pack'], ['Pre-arrival pack — tomorrow']])('%j is not an auto title', (t) => {
    expect(isAutoPackTitle(t, '2026-10-29T07:20:33Z')).toBe(false)
  })
})

describe('drafts and missing submission times are honest', () => {
  it('a draft has no report date, even if a submittedAt is passed', () => {
    const d = packDateDisplay({ ...UNIT75, status: 'draft' })
    expect(d.heading).toBe('Pre-arrival pack (draft)')
    expect(d.mainDate).toBeNull()
    expect(d.submittedAtText).toBeNull()
    expect(d.submittedLine).toBe('Not submitted yet')
    expect(d.reportDateIso).toBeNull()
    expect(d.draftCreatedLine).toBe('Draft created 29 Oct 2026, 09:20')
  })
  it('a submitted pack WITHOUT a submission time never borrows the draft date', () => {
    const d = packDateDisplay({ ...UNIT75, submittedAt: null })
    expect(d.heading).toBe('Pre-arrival pack')
    expect(d.mainDate).toBeNull()
    expect(d.submittedLine).toBe('Submitted — time not recorded')
    expect(d.reportDateIso).toBeNull()
    expect(d.draftCreatedOnOtherDay).toBe(false)
  })
  it('invalid timestamps are treated as missing', () => {
    expect(formatReportDateSAST('not a date')).toBeNull()
    const d = packDateDisplay({ ...UNIT75, submittedAt: 'garbage', startedAt: null })
    expect(d.submittedLine).toBe('Submitted — time not recorded')
    expect(d.draftCreatedLine).toBeNull()
  })
})
