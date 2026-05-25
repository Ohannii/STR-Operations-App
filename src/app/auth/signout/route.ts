import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * POST /auth/signout
 *
 * Clears the Supabase session cookie and redirects to /login.
 * Triggered by the "Sign out" form in the dashboard header.
 * Returns 303 so the redirect is followed by the browser as a GET.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
