/**
 * TRUSTED application origin (security review, 23 Jul; rev 3 preview-aware):
 * redirect origins for auth flows must come from CONFIGURATION or a TRUSTED
 * Vercel deploy variable - NEVER from request.url, Host or x-forwarded-* values,
 * all of which a client can influence. Parsed and normalised once; https-only
 * except explicit localhost.
 */

/**
 * The configured app origin. On a Vercel PREVIEW deployment we use the
 * Vercel-provided per-branch alias (VERCEL_BRANCH_URL) so an invite/reset
 * created on a preview stays on THAT preview's origin - a single
 * NEXT_PUBLIC_SITE_URL cannot serve many preview branches, which caused a
 * preview-generated invite to target the stable production domain. VERCEL_ENV
 * and VERCEL_BRANCH_URL are injected by Vercel at deploy time (server env
 * vars), NOT read from a client request/Host header, so this preserves the
 * no-host-injection guarantee. Production and everything else use
 * NEXT_PUBLIC_SITE_URL.
 */
export function configuredAppOrigin(): string | undefined {
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_BRANCH_URL) {
    return `https://${process.env.VERCEL_BRANCH_URL}`
  }
  return process.env.NEXT_PUBLIC_SITE_URL
}

export function trustedAppOrigin(
  env: string | undefined = configuredAppOrigin(),
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
  env: string | undefined = configuredAppOrigin(),
): string | null {
  const origin = trustedAppOrigin(env)
  if (!origin) return null
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return `${origin}${path}`
}
