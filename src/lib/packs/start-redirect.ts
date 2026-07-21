/**
 * Redirect target after "Start pre-arrival pack".
 *
 * Pure and unit-tested for one hard invariant: it must NEVER carry a camera
 * auto-open instruction (the old `capture_now=1`). URL-carried auto-open
 * outlived its moment in Next's router state and kept reopening the camera on
 * refresh/remount over the inspector's work (P0, 21 Jul 2026). The camera
 * opens only from an explicit tap on "Take photos".
 */
export function buildPackStartRedirect(
  propertyId: string,
  returnTo: string | null,
): string {
  if (returnTo) return returnTo
  return `/properties/${propertyId}?pack_started=1`
}
