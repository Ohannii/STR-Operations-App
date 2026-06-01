/**
 * Validates a `return_to` value submitted via a form so server
 * actions can safely redirect to it.
 *
 * Returns the raw value when it is a safe internal path scoped to
 * the given propertyId. Returns null otherwise — callers fall back
 * to their normal default redirect.
 *
 * Why this is paranoid:
 *   - `startsWith('/')` alone allows protocol-relative URLs like
 *     `//evil.com/path`, which browsers treat as absolute and
 *     navigate cross-origin.
 *   - A value containing `http://` or `https://` (even after a
 *     leading slash, or with mixed case) is also rejected.
 *   - Backslashes are rejected because some routers / proxies
 *     normalise `\` to `/`, which would let `/\evil.com` slip
 *     through a naive prefix check.
 *   - Scoping to `/properties/{propertyId}` ensures callers cannot
 *     bounce users to arbitrary in-app pages — the action that
 *     owns a given flag can only redirect back to that flag's
 *     apartment screen (with query / hash preserved).
 */
export function safeReturnTo(raw: unknown, propertyId: string): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  // Reject protocol-relative URLs (//example.com/...).
  if (value.startsWith('//')) return null

  // Reject anything containing an absolute URL scheme (case-insensitive)
  // or backslashes (which some intermediaries normalise to '/').
  const lowered = value.toLowerCase()
  if (lowered.includes('http://') || lowered.includes('https://')) return null
  if (value.includes('\\')) return null

  // propertyId must itself look like a plausible UUID-ish slug so
  // we cannot be tricked by a forged form value into accepting
  // `/properties/../foo`. Be strict: only safe URL-path chars.
  if (!/^[a-zA-Z0-9_-]+$/.test(propertyId)) return null

  // Must be an absolute in-app path scoped to this property.
  const prefix = `/properties/${propertyId}`
  if (value === prefix) return value
  if (
    value.startsWith(`${prefix}/`) ||
    value.startsWith(`${prefix}?`) ||
    value.startsWith(`${prefix}#`)
  ) {
    return value
  }
  return null
}
