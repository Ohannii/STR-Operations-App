/**
 * Absolute date/time formatting for operational UI.
 *
 * Timestamps are stored in UTC (Postgres `timestamptz`). Vercel's
 * server runtime is also UTC, so `Date#toLocaleString(undefined, …)`
 * renders in UTC on the server — which made a pack submitted at
 * 15:59 SAST display as "1:59 PM". On the client it would instead
 * use the device's zone, so server and client could even disagree
 * (a hydration hazard).
 *
 * These helpers pin the DISPLAY zone to Africa/Johannesburg (SAST,
 * UTC+2, no DST) so every surface — server- or client-rendered —
 * shows the team's wall-clock time consistently. Storage stays UTC;
 * this only affects how times are shown.
 *
 * Use these for any absolute timestamp shown to a user. Relative
 * strings ("2 hours ago") live in relative-time.ts and are
 * zone-agnostic by construction.
 */

const SAST_TIME_ZONE = 'Africa/Johannesburg'

type DateInput = string | number | Date | null | undefined

function toDate(input: DateInput): Date | null {
  if (input == null || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Date + time in SAST, e.g. "20 Jun 2026, 15:59". Returns "—" when empty/invalid. */
export function formatDateTimeSAST(input: DateInput): string {
  const d = toDate(input)
  if (!d) return '—'
  return d.toLocaleString('en-ZA', {
    timeZone: SAST_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Date only in SAST, e.g. "20 June 2026". Returns "—" when empty/invalid. */
export function formatDateSAST(input: DateInput): string {
  const d = toDate(input)
  if (!d) return '—'
  return d.toLocaleDateString('en-ZA', {
    timeZone: SAST_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
