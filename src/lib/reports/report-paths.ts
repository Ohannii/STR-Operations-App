import { createHash } from 'crypto'

/**
 * Report artifact identity — Slice 11C1.
 *
 * Flags are living cases, so their PDF must regenerate when the report
 * content changes. Rather than a DB revision counter, the artifact path
 * carries a deterministic CONTENT FINGERPRINT computed server-side from
 * exactly the data the PDF renders. Same content → same path → reuse the
 * existing immutable object; any change → new hash → new artifact, old
 * artifacts untouched.
 *
 * Submitted packs are immutable, so their path is stable (template only).
 *
 * `TEMPLATE_VERSION` bumps when the PDF *layout* changes (forces
 * regeneration independent of content).
 */

export const REPORT_ARTIFACTS_BUCKET = 'report-artifacts'
export const TEMPLATE_VERSION = 1

/** Photo identity that affects the rendered PDF (ordered). */
export type PhotoFingerprint = {
  id: string
  storagePath: string
  capturedAt: string | null
  uploadedAt: string | null
  notes: string | null
  width: number | null
  height: number | null
}

/** Report-relevant flag content that affects the rendered PDF. */
export type FlagFingerprintInput = {
  status: string
  severity: string
  issueTitle: string | null
  description: string | null
  chargeableParty: string | null
  noActionReason: string | null
  categoryKey: string
  raisedAt: string
  raisedBy: string
  closedAt: string | null
  /** In render order. */
  photos: PhotoFingerprint[]
}

/**
 * Deterministic content hash. Keys are written in a FIXED order and the
 * photo list preserves render order, so identical content always yields
 * an identical hash. 16 hex chars = 64 bits (ample for per-flag paths).
 */
export function flagContentHash(input: FlagFingerprintInput): string {
  const canonical = JSON.stringify({
    t: TEMPLATE_VERSION,
    status: input.status,
    severity: input.severity,
    issueTitle: input.issueTitle ?? '',
    description: input.description ?? '',
    chargeableParty: input.chargeableParty ?? '',
    noActionReason: input.noActionReason ?? '',
    categoryKey: input.categoryKey,
    raisedAt: input.raisedAt,
    raisedBy: input.raisedBy,
    closedAt: input.closedAt ?? '',
    photos: input.photos.map((p) => ({
      id: p.id,
      storagePath: p.storagePath,
      capturedAt: p.capturedAt ?? '',
      uploadedAt: p.uploadedAt ?? '',
      notes: p.notes ?? '',
      width: p.width ?? 0,
      height: p.height ?? 0,
    })),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export function flagReportObjectPath(
  companyId: string,
  flagId: string,
  contentHash: string,
): string {
  return `companies/${companyId}/flags/${flagId}/flag-report-t${TEMPLATE_VERSION}-${contentHash}.pdf`
}

export function packReportObjectPath(companyId: string, packId: string): string {
  return `companies/${companyId}/packs/${packId}/pack-report-t${TEMPLATE_VERSION}.pdf`
}

/**
 * Sanitized, length-limited, filesystem-safe ASCII filename. Strips
 * non-ASCII, converts dashes (incl. em dash) to hyphens, replaces unsafe
 * characters, and always ends in `.pdf`.
 */
/**
 * Sanitize to ASCII / filesystem-safe, length-limited. Preserves whatever
 * extension the caller already put in `raw` (e.g. `.jpg` or `.pdf`) — it does
 * NOT force one. Use this when the extension matters (Asana attachment names).
 */
export function sanitizeFilename(raw: string, maxLen = 120): string {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[‐-―−]/g, '-') // hyphen/en/em dash, minus → '-'
    .replace(/[^\x20-\x7E]/g, '') // strip remaining non-ASCII
    .replace(/[/\\?%*:|"<>]/g, ' ') // filesystem-unsafe → space
    .replace(/[\x00-\x1F\x7F]/g, ' ') // control chars → space
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
  return (cleaned || 'report').slice(0, maxLen).replace(/[-.\s]+$/g, '')
}

/** Sanitized PDF filename — always ends in `.pdf` (for the manual Share PDF). */
export function safeAsciiFilename(raw: string, maxLen = 120): string {
  const base = sanitizeFilename(raw, maxLen)
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

/**
 * Flag share/download filename: `{Unit Name} - {Flag Title} - DD-MM-YYYY.pdf`
 * (e.g. "Test 1 - Photo test - 16-07-2026.pdf"). Flag Title is the flag's
 * issue_title, falling back to "Flag" when empty. Sanitised to ASCII /
 * filesystem-safe and length-limited by safeAsciiFilename.
 */
export function flagShareFilename(
  unitName: string,
  flagTitle: string | null | undefined,
  dateStr: string,
): string {
  const title = (flagTitle ?? '').trim() || 'Flag'
  return safeAsciiFilename(`${unitName} - ${title} - ${dateStr}`)
}

export function packShareFilename(
  title: string,
  propertyName: string,
  dateStr: string,
): string {
  return safeAsciiFilename(`${title} ${propertyName} ${dateStr}`)
}
