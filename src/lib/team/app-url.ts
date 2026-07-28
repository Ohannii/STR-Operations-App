/**
 * TRUSTED application origin (security review, 23 Jul): redirect origins for
 * auth flows must come from configuration — NEVER from request.url, Host or
 * x-forwarded-* values, all of which a client can influence. Parsed and
 * normalised once; https-only except explicit localhost.
 */
export function trustedAppOrigin(
  env: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string | null {
  if (!env) return null
  let url: URL
  try {
    url = new URL(env)
  } catch {
    return null
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    return null
  }
  if (url.username || url.password) return null
  return url.origin // normalised: scheme + host (+ port), no path/query
}

/** Absolute URL for an internal path on the trusted origin, or null when
 *  the origin is unconfigured/invalid (callers must fail closed). */
export function trustedAppUrl(
  path: string,
  env: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string | null {
  const origin = trustedAppOrigin(env)
  if (!origin) return null
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return `${origin}${path}`
}
