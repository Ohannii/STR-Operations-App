'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { loginReturnPath } from '@/lib/auth/login-return'

/**
 * Server action invoked by the /login form.
 *
 * Validates input, calls signInWithPassword(), and:
 *   - on error: bounces back to /login?error=<message>
 *   - on success: returns to a safe requested app page, or /dashboard (pages bounce
 *     to /onboard if the user hasn't set up a company yet)
 */
export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const next = loginReturnPath(formData.get('next'))
  const failed = (message: string) => `/login?${new URLSearchParams({ error: message, next })}`

  if (!email || !password) {
    redirect(failed('Email and password are required.'))
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(failed(error.message))
  }

  redirect(next)
}
