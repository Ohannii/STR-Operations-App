import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthenticatedFromClaims } from '@/lib/auth/proxy-auth'

/**
 * Refresh the Supabase session cookie on every request.
 *
 * Called from src/middleware.ts. Returns the (possibly cookie-updated)
 * response AND the current user so the middleware can also do
 * lightweight redirect logic without a second auth round-trip.
 *
 * Why this dance with cookies:
 *   - Supabase stores the session in HttpOnly cookies on the response.
 *   - On expiry it issues a refreshed cookie. We must propagate that
 *     refreshed cookie both back to the browser (response.cookies.set)
 *     AND forward to downstream React Server Components on the same
 *     request (request.cookies.set + new NextResponse({ request })).
 *   - Skipping either side means stale sessions or lost refreshes.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Auth check via getClaims(): with the project's asymmetric (ECC P-256)
  // signing key the JWT is verified LOCALLY when the access token is still
  // valid — no Auth-server round-trip (the ~200ms/request we're removing).
  // getClaims() calls getSession() internally, so an EXPIRED token is still
  // refreshed via the refresh token and the new cookies are written through
  // the setAll handler above — cookie refresh is preserved.
  // TEMPORARY perf diagnostics (Slice 11a-perf) — remove after measuring.
  const _t = performance.now()
  const { data } = await supabase.auth.getClaims()
  console.log(`[perf][proxy] getClaims=${(performance.now() - _t).toFixed(0)}ms`)

  const authenticated = isAuthenticatedFromClaims(data)
  return { response, authenticated }
}
