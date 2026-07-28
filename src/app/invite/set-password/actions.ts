'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Sets the password for the AUTHENTICATED invited user via
 * supabase.auth.updateUser (the officially supported path for a signed-in
 * user). The password travels only in the POST body — never in a URL and
 * never logged. Minimum 8 characters (documented: stricter than legacy
 * signup's 6, because these accounts are provisioned for other people).
 */
export async function setInvitePasswordAction(formData: FormData) {
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  const fail = (msg: string) =>
    redirect(`/invite/set-password?error=${encodeURIComponent(msg)}`)

  if (password.length < 8) fail('Password must be at least 8 characters.')
  if (password !== confirm) fail('Passwords do not match.')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { error } = await supabase.auth.updateUser({ password })
  if (error) fail(error.message)

  redirect('/dashboard')
}
