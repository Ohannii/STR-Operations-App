'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

/**
 * Server action invoked by the /onboard form.
 *
 * Calls the create_company_with_admin RPC defined in migration
 * 20260525120000_auth_and_rls.sql. That function atomically creates
 * the company, the calling user's company_admin membership, and the
 * default approval policy — all under SECURITY DEFINER so it bypasses
 * the deliberately-restrictive INSERT policies on those tables.
 *
 * Idempotency: a future migration should add a "1 active membership per
 * user" guard inside the RPC. Until then we check at the app level here
 * — without it, a double-click silently creates two companies, and
 * downstream queries that assume one membership get confused.
 *
 * Diagnostics: every step logs to the server terminal (visible in
 * `pnpm dev`). Errors always redirect with a non-empty message.
 */
export async function createCompanyAction(formData: FormData) {
  const company_name = String(formData.get('company_name') ?? '').trim()

  if (!company_name) {
    redirect(`/onboard?error=${encodeURIComponent('Company name is required.')}`)
  }
  if (company_name.length < 2) {
    redirect(`/onboard?error=${encodeURIComponent('Company name is too short.')}`)
  }

  const supabase = await createClient()

  // Sanity-check the auth state from inside the action.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    console.error('[onboard] not authenticated in action:', authError)
    redirect(
      `/onboard?error=${encodeURIComponent(
        'You appear to be signed out. Please log in again.'
      )}`
    )
  }

  console.log('[onboard] action invoked', {
    user_id: user.id,
    email: user.email,
    company_name,
  })

  // Idempotency guard: if the user already has any active membership,
  // skip the RPC and just go to the dashboard. Prevents the "I clicked
  // again because nothing seemed to happen" trap.
  const { data: existing, error: existingError } = await supabase
    .from('company_memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(1)

  if (existingError) {
    console.error('[onboard] existing-membership check failed:', existingError)
    redirect(
      `/onboard?error=${encodeURIComponent(
        `Could not verify existing memberships: ${existingError.message}`
      )}`
    )
  }

  if (existing && existing.length > 0) {
    console.log('[onboard] user already has a membership; skipping RPC', existing[0])
    redirect('/dashboard')
  }

  // PR-A GUARD (rev 2): an authenticated email with a PENDING invitation
  // must never create a second company. Try the idempotent claim first; BOTH
  // the RPC data AND error are inspected — ONLY the literal 'no_invitation'
  // may proceed to company creation. Any error or any other typed result
  // (expired/revoked/conflict/unknown) blocks creation with a safe, retryable
  // message. The database itself backstops this: create_company_with_admin
  // raises 'invitation_pending' / 'already_member' regardless of app checks.
  const { data: claim, error: claimError } = await supabase.rpc('claim_pending_invitation')
  if (claimError) {
    console.error('[onboard] claim_pending_invitation errored; blocking creation:', claimError)
    redirect(
      `/onboard?error=${encodeURIComponent(
        'We could not check your invitations just now. Please try again — do not create a new company if you were invited to one.'
      )}`
    )
  }
  if (claim === 'claimed' || claim === 'already_member') {
    console.log('[onboard] pending invitation claimed instead of creating a company')
    redirect('/dashboard')
  }
  if (claim !== 'no_invitation') {
    // expired / revoked / conflict / anything unexpected: never proceed.
    console.error('[onboard] claim returned non-proceed result; blocking creation:', claim)
    const msg =
      claim === 'expired'
        ? 'Your invitation has expired. Ask your admin to resend it instead of creating a company.'
        : claim === 'revoked'
          ? 'Your invitation was revoked. Contact your admin instead of creating a company.'
          : claim === 'conflict'
            ? 'Your account is already linked to another company. Contact your admin.'
            : 'An invitation exists for this account and must be resolved first. Contact your admin.'
    redirect(`/onboard?error=${encodeURIComponent(msg)}`)
  }

  console.log('[onboard] calling create_company_with_admin RPC')
  const { data: newCompanyId, error: rpcError } = await supabase.rpc(
    'create_company_with_admin',
    { p_company_name: company_name }
  )

  if (rpcError) {
    console.error('[onboard] RPC error:', rpcError)
    const message = rpcError.message || rpcError.code || 'Unknown RPC error'
    redirect(`/onboard?error=${encodeURIComponent(`Could not create company: ${message}`)}`)
  }

  console.log('[onboard] RPC returned new company id:', newCompanyId)

  // Verify the membership is now readable through the user's RLS-scoped
  // session. If not, surface a clear message instead of silently bouncing.
  const { data: postCheck, error: postError } = await supabase
    .from('company_memberships')
    .select('company_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(1)

  if (postError) {
    console.error('[onboard] post-RPC membership read failed:', postError)
  }
  console.log('[onboard] post-RPC membership rows:', postCheck?.length ?? 0)

  if (!postCheck || postCheck.length === 0) {
    redirect(
      `/onboard?error=${encodeURIComponent(
        'Company was created but your membership is not visible. This is an RLS bug — please report it.'
      )}`
    )
  }

  redirect('/dashboard')
}
