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
  const fullName = String(formData.get('full_name') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  const fail = (msg: string) =>
    redirect(`/invite/set-password?error=${encodeURIComponent(msg)}`)

  if (!fullName) fail('Please enter your name.')
  if (fullName.length > 120) fail('Please enter a shorter name.')
  if (password.length < 8) fail('Password must be at least 8 characters.')
  if (password !== confirm) fail('Passwords do not match.')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Set the password AND mirror the display name into auth metadata.
  const { error } = await supabase.auth.updateUser({
    password,
    data: { full_name: fullName },
  })
  if (error) fail(error.message)

  // Persist the name to the user's own profile (the "users update own profile"
  // RLS policy permits id = auth.uid()). This is what the Team list and the
  // dashboard greeting read, so members show by name rather than email.
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ full_name: fullName })
    .eq('id', user.id)
  if (profileError) fail(profileError.message)

  redirect('/dashboard')
}
