import { sanitizeFilename } from '@/lib/reports/report-paths'

/**
 * Deterministic-yet-readable Asana attachment names + the idempotency
 * planner (Slice 11C2). PURE — no I/O.
 *
 * Names are readable for managers but carry a STABLE suffix that is the
 * real idempotency key:
 *   - PDF:   `{Unit} - {Flag Title} - {Raised DD-MM-YYYY} - {hash8}.pdf`
 *   - Photo: `{Unit} - {Flag Title} - Photo {ordinal} - {photoId8}.jpg`
 * The readable prefix may change (e.g. a retitled flag); matching is done
 * ONLY on the trailing key (hash8 / photoId8), so re-runs never duplicate.
 */

export function pdfHash8(contentHash: string): string {
  return contentHash.slice(0, 8).toLowerCase()
}

export function photoId8(photoId: string): string {
  return photoId.replace(/-/g, '').slice(0, 8).toLowerCase()
}

export function pdfAttachmentName(
  unit: string,
  flagTitle: string,
  raisedDMY: string,
  contentHash: string,
): string {
  // sanitizeFilename (NOT safeAsciiFilename) so the .pdf/.jpg extension is
  // preserved exactly — the extension is part of the idempotency key parser.
  return sanitizeFilename(
    `${unit} - ${flagTitle} - ${raisedDMY} - ${pdfHash8(contentHash)}.pdf`,
  )
}

export function photoAttachmentName(
  unit: string,
  flagTitle: string,
  ordinal: number,
  photoId: string,
): string {
  return sanitizeFilename(
    `${unit} - ${flagTitle} - Photo ${ordinal} - ${photoId8(photoId)}.jpg`,
  )
}

/** Extract the PDF idempotency key (hash8) from an attachment name, or null. */
export function pdfKeyFromName(name: string): string | null {
  const m = /(?:^|[-\s])([0-9a-f]{8})\.pdf$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : null
}

/** Extract the photo idempotency key (photoId8) from an attachment name, or null. */
export function photoKeyFromName(name: string): string | null {
  const m = /(?:^|[-\s])([0-9a-f]{8})\.jpg$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : null
}

export type EvidencePhotoRef = { photoId: string; ordinal: number }

export type EvidenceUploadPlan = {
  uploadPdf: boolean
  /** Photo ids (full) that still need uploading, in order. */
  photosToUpload: EvidencePhotoRef[]
}

/**
 * Given the task's EXISTING attachment names, the current PDF content hash,
 * and the flag's ordered photos, decide what still needs uploading. Matching
 * is by trailing idempotency key only, so:
 *   - an unchanged PDF (same hash8 present) is skipped;
 *   - a content change (new hash8) uploads a new PDF, old one untouched;
 *   - photos already present (by photoId8) are skipped;
 *   - partial success / crash-retry uploads only the remainder.
 */
export function planEvidenceUploads(input: {
  existingNames: string[]
  contentHash: string
  photos: EvidencePhotoRef[]
}): EvidenceUploadPlan {
  const pdfKeys = new Set(
    input.existingNames.map(pdfKeyFromName).filter((k): k is string => k != null),
  )
  const photoKeys = new Set(
    input.existingNames.map(photoKeyFromName).filter((k): k is string => k != null),
  )

  const wantPdf = pdfHash8(input.contentHash)
  const uploadPdf = !pdfKeys.has(wantPdf)

  const photosToUpload = input.photos.filter((p) => !photoKeys.has(photoId8(p.photoId)))

  return { uploadPdf, photosToUpload }
}
