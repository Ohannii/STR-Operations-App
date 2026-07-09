/**
 * Trigger-secret check for the manual worker route (Slice 7).
 *
 * Pure + fail-closed: returns false unless BOTH a provided and an
 * expected secret exist and match. Uses a length-guarded, constant-time
 * comparison to avoid timing leaks.
 */
export function isValidTriggerSecret(
  provided: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}
