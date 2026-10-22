'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Recovery password setup (PR-A rev 3). Runs for a user who has an ACTIVE
 * recovery session (established by POST /auth/recover -> verifyOtp recovery).
 *
 * Key differences from the invite set-password action:
 *  - it does NOT claim any invitation. A pending-invite user reaches
 *    /dashboard, which forwards no-company users to /onboard, where the
 *    existing claim logic completes membership. So membership is never granted
 *    before password setup here either.
 *  - the name is OPTIONAL: existing users keep their name by leaving it blank;
 *    a user whose profile still holds the email fallback (e.g. an account that
 *    was auto-provisioned) can set a real name here.
 *
 * All writes target the AUTHENTICATED recovery user (auth.uid()), so an
 * unrelated signed-in session cannot receive the password/profile update.
 */
export async function setRecoveryPasswordAction(formData: FormData) {
  const fullName = String(formData.get('full_name') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  const fail = (msg: string) =>
    redirect(`/reset-password?error=${encodeURIComponent(msg)}`)

  if (fullName.length > 120) fail('Please enter a shorter name.')
  if (password.length < 8) fail('Password must be at least 8 characters.')
  if (password !== confirm) fail('Passwords do not match.')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?error=' + encodeURIComponent('Your reset link has expired. Please request another.'))

  const { error } = await supabase.auth.updateUser(
    fullName ? { password, data: { full_name: fullName } } : { password },
  )
  if (error) fail(error.message)

  if (fullName) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', user.id)
    if (profileError) {
      // Do not leak a raw DB error into the URL/UI; log it server-side.
      console.error('[reset-password] profile update failed:', profileError)
      fail('We could not save your name; please try again.')
    }
  }

  // No invitation is claimed here. A recovering EXISTING member already has
  // their membership; a pending invitee completes acceptance via the invite
  // set-password flow, not recovery.
  redirect('/dashboard')
}
