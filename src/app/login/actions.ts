'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

/**
 * Server action invoked by the /login form.
 *
 * Validates input, calls signInWithPassword(), and:
 *   - on error: bounces back to /login?error=<message>
 *   - on success: redirects to /dashboard (middleware will then bounce
 *     to /onboard if the user hasn't set up a company yet)
 */
export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent('Email and password are required.')}`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`)
  }

  redirect('/dashboard')
}
