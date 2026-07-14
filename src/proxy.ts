import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { resolveProxyRedirect } from '@/lib/auth/proxy-auth'

/**
 * Next.js 16 proxy (was called middleware before v16).
 * Runs on every matched request.
 *
 * Responsibilities:
 *   1. Refresh the Supabase session cookie (updateSession).
 *   2. Cheap redirect rules based on logged-in / logged-out state
 *      (see resolveProxyRedirect). DOES NOT check whether the user has a
 *      company — pages handle "no company → /onboard" themselves.
 *
 * The auth signal now comes from getClaims() (local JWT verification via
 * the project's asymmetric key), so protected-route checks no longer cost
 * an Auth-server round-trip on every request.
 */
export async function proxy(request: NextRequest) {
  const { response, authenticated } = await updateSession(request)

  const redirect = resolveProxyRedirect(authenticated, request.nextUrl.pathname)
  if (redirect) {
    const url = request.nextUrl.clone()
    url.pathname = redirect.pathname
    if (redirect.setNext) url.searchParams.set('next', request.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  // Match everything except static assets and the health endpoint.
  // /api/health needs to stay reachable without auth for connection checks.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
}
