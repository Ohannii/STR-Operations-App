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
  if (error) {
    // A previous attempt can save the password before profile/claim fails or
    // its response is lost. This exact Auth code confirms the submitted value
    // is already the current user's password; other errors must still stop.
    if (error.code !== 'same_password') fail(error.message)

    // The rejected combined update did not save its metadata. Retry only the
    // name, without asking Auth to change the same password a second time.
    const { error: nameError } = await supabase.auth.updateUser({
      data: { full_name: fullName },
    })
    if (nameError) fail('We could not save your details. Please try again.')
  }

  // Persist the name to the user's own profile (the "users update own profile"
  // RLS policy permits id = auth.uid()). This is what the Team list and the
  // dashboard greeting read, so members show by name rather than email.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .update({ full_name: fullName })
    .eq('id', user.id)
    .select('id')
    .maybeSingle()
  if (profileError) {
    // Never leak a raw DB error (e.g. "permission denied for table profiles")
    // into the URL/UI. Log server-side and show a safe message. Membership is
    // NOT claimed on this failure, so the invitation stays pending/inactive.
    console.error('[invite/set-password] profile update failed:', profileError)
    fail('Your password is saved, but we could not save your name. Please try again with the same details.')
  }
  // A zero-row update is not a successful setup, even without a DB error.
  if (profile?.id !== user.id) fail('We could not find your team profile. Please contact your admin.')

  // Acceptance happens ONLY here, and ONLY after password + profile have both
  // succeeded: this is the SOLE path that creates the membership / sets
  // accepted_at. /auth/confirm (verify) and /onboard deliberately do NOT claim,
  // so a mere authenticated session can never activate membership without
  // completed setup.
  const { data: claim, error: claimError } = await supabase.rpc('claim_pending_invitation')
  if (claimError) {
    console.error('[invite/set-password] claim failed:', claimError)
    fail('Your password is saved, but joining the team did not finish. Please try again with the same details.')
  }
  // FAIL CLOSED: only 'claimed' or 'already_member' count as success. Every
  // other outcome (no_invitation, expired, revoked, conflict, anything else)
  // does NOT complete acceptance - no membership is granted.
  if (claim !== 'claimed' && claim !== 'already_member') {
    console.error('[invite/set-password] non-success claim outcome:', claim)
    const msg =
      claim === 'expired'
        ? 'This invitation has expired. Ask your admin to renew it.'
        : claim === 'revoked'
          ? 'This invitation was revoked. Contact your admin.'
          : claim === 'conflict'
            ? 'This account is already active in another company. Ask your admin about a transfer.'
            : 'We could not complete your invitation. Ask your admin to resend it.'
    fail(msg)
  }

  redirect('/dashboard')
}
