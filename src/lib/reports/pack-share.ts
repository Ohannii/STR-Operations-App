/**
 * Pure helpers for pre-arrival pack sharing (report-share-polish slice).
 * No I/O — unit-testable.
 */

/** "1 bedroom" / "2 bedrooms" / … ; null when the count is genuinely absent. */
export function bedroomLabel(count: number | null | undefined): string | null {
  if (count == null || !Number.isFinite(count) || count < 0) return null
  return count === 1 ? '1 bedroom' : `${count} bedrooms`
}

/**
 * Readable share text for a pre-arrival pack: a header plus a bullet list of
 * the photos that HAVE a description, numbered by their position in the
 * report (matching the PDF's "Photo N" labels). Photos with a blank/undefined
 * caption are omitted. If no photo has a caption, only the header is returned.
 *
 *   Pre-arrival report — Unit Nr - 95
 *   Photo notes:
 *   • Photo 1: Fridge door has a small mark
 *   • Photo 2: Bathroom towel rail is loose
 */
export function buildPackShareNotes(
  unitLabel: string,
  photos: { caption: string | null }[],
): string {
  const bullets: string[] = []
  photos.forEach((p, i) => {
    const cap = (p.caption ?? '').trim()
    if (cap) bullets.push(`• Photo ${i + 1}: ${cap}`)
  })
  const header = `Pre-arrival report — ${unitLabel}`
  return bullets.length === 0 ? header : `${header}\nPhoto notes:\n${bullets.join('\n')}`
}
