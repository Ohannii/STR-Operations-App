/**
 * THE ONE CAPTION NORMALIZATION RULE (rev 4, 26 Oct).
 *
 * Every caption comparison in the app and the database uses this rule — the
 * typed note, the expected baseline, the stored photos.notes value, and the
 * submitted-replay comparison:
 *
 *   canonical(x) = x with leading/trailing ASCII whitespace
 *                  (space, \t, \n, \r, \f, \v) removed; '' == "no caption".
 *
 * It mirrors the SQL expression used in migration 20261022090000:
 *   nullif(btrim(coalesce(x, ''), E' \t\n\r\f\v'), '')
 * JavaScript's String.prototype.trim() is NOT used for comparisons: it also
 * strips Unicode spaces (e.g. U+00A0), which Postgres btrim would keep, and
 * that mismatch would turn legacy captions into unresolvable conflicts.
 */

const EDGE_WS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g

/** Canonical text form ('' = no caption). */
export function canonicalCaption(x: string | null | undefined): string {
  return (x ?? '').replace(EDGE_WS, '')
}

/** Canonical database form (null = no caption). */
export function canonicalCaptionOrNull(x: string | null | undefined): string | null {
  const c = canonicalCaption(x)
  return c === '' ? null : c
}

export function sameCaption(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalCaption(a) === canonicalCaption(b)
}

/**
 * THE caption length limit (rev 5). Checked on the RAW string, BEFORE
 * canonicalization — exactly like the SQL boundary — so 2,001 whitespace
 * characters cannot slip through by canonicalizing to blank. Over-limit text
 * is REFUSED, never silently shortened. (JS counts UTF-16 units, which is
 * never fewer than Postgres characters: anything JS accepts, SQL accepts.)
 */
export const MAX_CAPTION_LENGTH = 2000

export function captionTooLong(raw: string | null | undefined): boolean {
  return (raw ?? '').length > MAX_CAPTION_LENGTH
}

export const CAPTION_TOO_LONG_MESSAGE =
  'A caption is longer than 2,000 characters. Shorten it, then attach again — nothing was attached.'
