import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

  // IMPORTANT: getUser() (not getSession()) is the only way to revalidate
  // the user against the Auth server. getSession() trusts the JWT locally.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return { response, user }
}
