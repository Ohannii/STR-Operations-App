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

  // SECURITY (rev 3 - fail-open fix): do NOT claim a pending invitation here.
  // Claiming from the onboarding path activated membership without completed
  // password + profile setup. Invite acceptance happens ONLY in the
  // set-password action. The database still backstops company creation:
  // create_company_with_admin raises 'invitation_pending' for an invited user,
  // which we route to /invite/set-password below.
  console.log('[onboard] calling create_company_with_admin RPC')
  const { data: newCompanyId, error: rpcError } = await supabase.rpc(
    'create_company_with_admin',
    { p_company_name: company_name }
  )

  if (rpcError) {
    console.error('[onboard] create_company_with_admin error:', rpcError)
    const raw = rpcError.message ?? ''
    if (raw.includes('invitation_pending')) {
      // Invited user: they must COMPLETE their invitation (password + profile),
      // not create a company. Route them to the set-password flow.
      redirect('/invite/set-password')
    }
    if (raw.includes('already_member')) {
      redirect('/dashboard')
    }
    // Safe, generic message; the raw DB error stays in server logs only.
    redirect(
      `/onboard?error=${encodeURIComponent('Could not create your company. Please try again.')}`,
    )
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
