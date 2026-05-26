import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /auth/callback?code=...&next=/dashboard
 *
 * Handler for the link inside Supabase confirmation / magic-link emails.
 * Exchanges the PKCE `code` for a session cookie, then sends the user
 * onward. If exchange fails, bounces them to /login with an error.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent('Authentication link was invalid or has expired.')}`
  )
}
