/**
 * Pure helpers for the proxy auth check (Slice 11a-perf).
 *
 * No Next.js or Supabase imports, so these are unit-testable without a
 * runtime. The proxy derives its auth signal + redirect decision from
 * these; behaviour is identical to the previous inline logic.
 */

// Pages a LOGGED-OUT user should NOT reach.
export const PROTECTED_PREFIXES = ['/dashboard', '/properties', '/onboard'] as const

// Pages a LOGGED-IN user should NOT see again (sent home).
export const AUTH_PAGES = new Set<string>(['/login', '/signup'])

/**
 * Authenticated iff the locally-verified JWT carries a subject (user id).
 * `data` is the shape returned by `supabase.auth.getClaims()`.
 */
export function isAuthenticatedFromClaims(
  data: { claims?: { sub?: string } | null } | null | undefined,
): boolean {
  return Boolean(data?.claims?.sub)
}

export type ProxyRedirect = { pathname: string; setNext: boolean }

/**
 * Decide whether the proxy should redirect. Returns null to continue.
 *   - unauthenticated + protected route → /login (preserve `next`)
 *   - authenticated + login/signup page → /dashboard
 */
export function resolveProxyRedirect(
  authenticated: boolean,
  path: string,
): ProxyRedirect | null {
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/'),
  )
  const isAuthPage = AUTH_PAGES.has(path)

  if (!authenticated && isProtected) return { pathname: '/login', setNext: true }
  if (authenticated && isAuthPage) return { pathname: '/dashboard', setNext: false }
  return null
}
