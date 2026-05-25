'use server'

import { createClient } from '@/lib/supabase/server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

/**
 * Server action invoked by the /signup form.
 *
 * Calls signUp() with full_name passed as user metadata so the
 * handle_new_user() trigger can pick it up and populate profiles.full_name.
 *
 * Behaviour depends on the project's "Confirm email" setting:
 *   - confirmation OFF → signUp returns a live session; we send the user
 *     to /dashboard (middleware will bounce to /onboard).
 *   - confirmation ON  → signUp returns no session; user must click the
 *     email link. We send them to /login with a friendly "check your
 *     email" message.
 */
export async function signupAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const full_name = String(formData.get('full_name') ?? '').trim()

  if (!email || !password || !full_name) {
    redirect(`/signup?error=${encodeURIComponent('All fields are required.')}`)
  }
  if (password.length < 6) {
    redirect(`/signup?error=${encodeURIComponent('Password must be at least 6 characters.')}`)
  }

  // Build an absolute URL for the email confirmation callback.
  // headers() gives us the actual host the browser hit, so this works
  // for localhost, Vercel previews, and production alike.
  const headerList = await headers()
  const host = headerList.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const emailRedirectTo = `${protocol}://${host}/auth/callback?next=/dashboard`

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name },
      emailRedirectTo,
    },
  })

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`)
  }

  if (data.session) {
    // Auto-signed-in. Middleware will route to /onboard if no company yet.
    redirect('/dashboard')
  }

  // Confirmation required. Friendly nudge.
  redirect(
    `/login?message=${encodeURIComponent(
      'Account created. Check your email for a confirmation link, then log in.'
    )}`
  )
}
