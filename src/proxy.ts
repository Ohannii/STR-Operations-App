import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Next.js 16 proxy (was called middleware before v16).
 * Runs on every matched request.
 *
 * Responsibilities:
 *   1. Refresh the Supabase session cookie (updateSession).
 *   2. Cheap redirect rules based on logged-in / logged-out state.
 *      DOES NOT check whether the user has a company — that's an
 *      extra round trip we don't want on every request. Pages
 *      handle "no company → /onboard" themselves.
 */

// Pages where a LOGGED-OUT user should NOT be allowed.
// Anything starting with one of these prefixes is protected.
const PROTECTED_PREFIXES = ['/dashboard', '/properties', '/onboard'] as const

// Pages where a LOGGED-IN user should NOT see again (we send them home).
const AUTH_PAGES = new Set(['/login', '/signup'])

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)

  const path = request.nextUrl.pathname

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/')
  )
  const isAuthPage = AUTH_PAGES.has(path)

  if (!user && isProtected) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  if (user && isAuthPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  // Match everything except static assets and the health endpoint.
  // /api/health needs to stay reachable without auth for connection checks.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/health).*)',
  ],
}
