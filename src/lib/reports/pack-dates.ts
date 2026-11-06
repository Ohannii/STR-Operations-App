/**
 * Pre-arrival pack DATE DISPLAY (display + PDF only; no data changes).
 *
 * A pack's stored title is set when its DRAFT is created ("Pre-arrival
 * pack — 29 Oct 2026, 09:20"). A draft can stay open for days and be
 * submitted later, so that auto title shows the wrong day for the report
 * (Unit 75, 3 Nov 2026: draft created 29 Oct, submitted 3 Nov).
 *
 * Rules:
 *   - A SUBMITTED pack is dated by its submission time, in South Africa
 *     time (Africa/Johannesburg, fixed UTC+2).
 *   - An auto title (the draft-creation default) is replaced for display
 *     by "Pre-arrival pack — <submission date>". A CUSTOM title is kept
 *     exactly, and the submission date is shown alongside it.
 *   - "Draft created <time>" is kept as secondary detail.
 *   - Drafts and submitted packs WITHOUT a submission time never invent a
 *     date: they say so honestly.
 *
 * Stored timestamps and titles are never modified here.
 */

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000 // Africa/Johannesburg: UTC+2, no DST
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const PACK_DEFAULT_LABEL = 'Pre-arrival pack'
/** The prefix startPreArrivalPackAction uses for the draft's default title. */
const AUTO_TITLE_PREFIX = `${PACK_DEFAULT_LABEL} — `

type DateInput = string | number | Date | null | undefined

function toDate(input: DateInput): Date | null {
  if (input == null || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Wall-clock parts in South Africa time (deterministic; no locale data). */
function sastParts(d: Date) {
  const s = new Date(d.getTime() + SAST_OFFSET_MS)
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth(),
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "3 Nov 2026" in South Africa time; null when empty/invalid. */
export function formatReportDateSAST(input: DateInput): string | null {
  const d = toDate(input)
  if (!d) return null
  const p = sastParts(d)
  return `${p.day} ${MONTHS[p.month]} ${p.year}`
}

/** "3 Nov 2026, 16:02" in South Africa time (24h); null when empty/invalid. */
export function formatReportDateTimeSAST(input: DateInput): string | null {
  const d = toDate(input)
  if (!d) return null
  const p = sastParts(d)
  return `${p.day} ${MONTHS[p.month]} ${p.year}, ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** Same South Africa calendar day? */
export function isSameSastDay(a: DateInput, b: DateInput): boolean {
  const x = formatReportDateSAST(a)
  return x !== null && x === formatReportDateSAST(b)
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Parse the date/time part of an auto title as wall-clock parts. Accepts
 * every format the default title has been written in (Vercel's locale data
 * changed over time):
 *   "29 Oct 2026, 09:20" · "25 Sept 2026, 13:41" · "2026/06/01, 20:50" ·
 *   "06/20/2026, 01:59 PM"
 */
function parseTitleStamp(s: string): { y: number; m: number; d: number; h: number; min: number } | null {
  let r = /^(\d{1,2}) ([A-Za-z]{3,4}) (\d{4}), (\d{2}):(\d{2})$/.exec(s)
  if (r) {
    const m = MONTH_INDEX[r[2].toLowerCase()]
    if (m === undefined) return null
    return { y: +r[3], m, d: +r[1], h: +r[4], min: +r[5] }
  }
  r = /^(\d{4})\/(\d{2})\/(\d{2}), (\d{2}):(\d{2})$/.exec(s)
  if (r) return { y: +r[1], m: +r[2] - 1, d: +r[3], h: +r[4], min: +r[5] }
  r = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}) (AM|PM)$/.exec(s)
  if (r) {
    let h = +r[4] % 12
    if (r[6] === 'PM') h += 12
    return { y: +r[3], m: +r[1] - 1, d: +r[2], h, min: +r[5] }
  }
  return null
}

/**
 * True when `title` is the DEFAULT title generated at draft creation:
 * exactly "Pre-arrival pack — <stamp>" where <stamp> is the draft's own
 * creation minute (written as South Africa or, for a few early packs, UTC
 * wall time), within 2 minutes. Anything else is a custom title and is kept.
 */
export function isAutoPackTitle(title: string | null | undefined, startedAt: DateInput): boolean {
  const t = (title ?? '').trim()
  if (!t.startsWith(AUTO_TITLE_PREFIX)) return false
  const started = toDate(startedAt)
  if (!started) return false
  const p = parseTitleStamp(t.slice(AUTO_TITLE_PREFIX.length))
  if (!p) return false
  const wallAsUtc = Date.UTC(p.y, p.m, p.d, p.h, p.min)
  const asSast = wallAsUtc - SAST_OFFSET_MS
  const near = (instant: number) => Math.abs(instant - started.getTime()) < 2 * 60_000
  return near(asSast) || near(wallAsUtc)
}

export type PackDateDisplay = {
  /** The main display title for History, the report heading and the PDF. */
  heading: string
  /** The kept custom title, or null when the title is the auto default. */
  customTitle: string | null
  /** Main report date, e.g. "3 Nov 2026" (submitted packs with a time only). */
  mainDate: string | null
  /** "3 Nov 2026, 16:02" (submitted packs with a time only). */
  submittedAtText: string | null
  /** "Submitted 3 Nov 2026, 16:02" · "Submitted — time not recorded" · "Not submitted yet". */
  submittedLine: string
  /** "29 Oct 2026, 09:20" or null when unknown. */
  draftCreatedText: string | null
  /** "Draft created 29 Oct 2026, 09:20" or null when unknown. */
  draftCreatedLine: string | null
  /** True when the draft was created on a different South Africa day. */
  draftCreatedOnOtherDay: boolean
  /** ISO for the report date (submission time only — never the draft time). */
  reportDateIso: string | null
}

export function packDateDisplay(input: {
  status: string
  title: string | null | undefined
  startedAt: DateInput
  submittedAt: DateInput
  /** Fallback label (default "Pre-arrival pack"). */
  label?: string
}): PackDateDisplay {
  const label = input.label ?? PACK_DEFAULT_LABEL
  const rawTitle = (input.title ?? '').trim()
  const customTitle = rawTitle && !isAutoPackTitle(rawTitle, input.startedAt) ? rawTitle : null
  const submitted = input.status === 'submitted'
  const submittedAt = submitted ? toDate(input.submittedAt) : null

  const mainDate = submittedAt ? formatReportDateSAST(submittedAt) : null
  const submittedAtText = submittedAt ? formatReportDateTimeSAST(submittedAt) : null
  const draftCreatedText = formatReportDateTimeSAST(input.startedAt)

  let heading: string
  if (customTitle) heading = customTitle
  else if (mainDate) heading = `${label} — ${mainDate}`
  else if (submitted) heading = label // submitted, but no recorded time: no invented date
  else heading = `${label} (draft)`

  const submittedLine = submittedAtText
    ? `Submitted ${submittedAtText}`
    : submitted
      ? 'Submitted — time not recorded'
      : 'Not submitted yet'

  return {
    heading,
    customTitle,
    mainDate,
    submittedAtText,
    submittedLine,
    draftCreatedText,
    draftCreatedLine: draftCreatedText ? `Draft created ${draftCreatedText}` : null,
    draftCreatedOnOtherDay:
      submittedAt !== null && draftCreatedText !== null && !isSameSastDay(submittedAt, input.startedAt),
    reportDateIso: submittedAt ? submittedAt.toISOString() : null,
  }
}
