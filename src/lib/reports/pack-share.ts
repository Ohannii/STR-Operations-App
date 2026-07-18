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
 * Readable share text for a pre-arrival pack: a bold heading (WhatsApp
 * asterisk syntax) that refers to the PDF shared underneath, plus a bullet
 * list of the photos that HAVE a description, numbered by their position in
 * the report (matching the PDF's "Photo N" labels). Photos with a
 * blank/undefined caption are omitted.
 *
 * When NO photo has a caption, returns an EMPTY STRING so the native share
 * carries only the PDF — never an empty or heading-only notes message.
 *
 *   *📝 Notes for the pre-arrival report below — Unit Nr - 95*
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
  if (bullets.length === 0) return ''
  const heading = `*📝 Notes for the pre-arrival report below — ${unitLabel}*`
  return `${heading}\n${bullets.join('\n')}`
}
