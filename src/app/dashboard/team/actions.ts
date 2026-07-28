'use server'

import { revalidatePath } from 'next/cache'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { trustedAppUrl } from '@/lib/team/app-url'
import { canonicalEmail, isInvitableRole } from '@/lib/team/team-helpers'

/**
 * PR-A team actions (rev 2, security review applied).
 *
 * ORDERING INVARIANT: the trusted DATABASE invitation record is created (or
 * reused) BEFORE any Supabase Auth Admin call. If Auth provisioning fails,
 * the lifecycle is marked provisioning_failed and a retry converges on the
 * SAME record — an invited person can therefore never authenticate without
 * a database intent existing, and can never fall through to /onboard
 * (which is also blocked at the database inside create_company_with_admin).
 *
 * Identity: the Auth user id/email/confirmed-state passed to finalisation
 * come from the AUTH ADMIN RESPONSE in this trusted server file — never
 * from the browser — and the database re-validates the email match anyway.
 */

type ActionResult =
  | { ok: true; code: string; shareLink?: string }
  | { ok: false; code: string; error: string }

async function requireAdmin(): Promise<
  | { ok: true; ctx: NonNullable<Awaited<ReturnType<typeof getUserContext>>>; companyId: string }
  | { ok: false; code: string; error: string }
> {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) return { ok: false, code: 'unauthenticated', error: 'Sign in first.' }
  if (ctx.membership?.role_key !== 'company_admin') {
    return { ok: false, code: 'not_authorized', error: 'Only a company admin can manage the team.' }
  }
  // ctx.company is proven non-null by the guard above; capture the trusted id
  // so company-scoped callers never re-dereference a possibly-null company.
  return { ok: true, ctx, companyId: ctx.company.id }
}

type AuthUserLite = { id: string; email: string; confirmed: boolean }

async function findAuthUserByEmail(email: string): Promise<AuthUserLite | null> {
  const admin = createServiceClient()
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(error.message)
    const hit = data.users.find((u) => canonicalEmail(u.email ?? '') === email)
    if (hit) {
      return {
        id: hit.id,
        email: canonicalEmail(hit.email ?? ''),
        // Trusted Auth data decides confirmed-ness — never a caller flag.
        confirmed: Boolean(hit.email_confirmed_at),
      }
    }
    if (data.users.length < 200) return null
    page += 1
  }
}

function conflictResult(message: string): ActionResult {
  const companyName = message.split(':').slice(1).join(':') || 'another company'
  return {
    ok: false,
    code: 'existing_company_conflict',
    error:
      `That person is already an active member of "${companyName}". No changes ` +
      'were made and no email was sent. Moving people between companies needs ' +
      'a controlled transfer (not available yet).',
  }
}

export async function inviteTeamMember(input: {
  email: string
  roleKey: string
}): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return gate
  const { companyId } = gate
  const email = canonicalEmail(input.email ?? '')
  if (!email || !email.includes('@')) {
    return { ok: false, code: 'bad_email', error: 'Enter a valid email address.' }
  }
  if (!isInvitableRole(input.roleKey)) {
    return { ok: false, code: 'bad_role', error: 'That role cannot be granted here.' }
  }

  const supabase = await createClient()

  // STEP 1: the DATABASE record comes first. Conflicts and already-member
  // resolve here — before any email could possibly be sent.
  const { data: beginRows, error: beginErr } = await supabase.rpc('begin_team_invitation', {
    p_company_id: companyId,
    p_email: email,
    p_role_key: input.roleKey,
  })
  if (beginErr) {
    if (beginErr.message.startsWith('existing_company_conflict')) {
      return conflictResult(beginErr.message)
    }
    return { ok: false, code: 'begin_failed', error: beginErr.message }
  }
  const begin = Array.isArray(beginRows) ? beginRows[0] : beginRows
  if (!begin) return { ok: false, code: 'begin_failed', error: 'Invitation could not start.' }
  if (begin.outcome === 'already_member') {
    return { ok: true, code: 'already_member' }
  }
  const invitationId: string = begin.invitation_id

  // STEP 2: Auth resolution/provisioning — only now.
  const adminClient = createServiceClient()
  let authUser: AuthUserLite | null
  try {
    authUser = await findAuthUserByEmail(email)
    if (!authUser) {
      const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email)
      if (error) {
        // Race: created between lookup and invite → converge via re-lookup.
        authUser = await findAuthUserByEmail(email)
        if (!authUser) {
          await supabase.rpc('mark_invitation_failed', {
            p_invitation_id: invitationId,
            p_reason: `auth invite failed: ${error.message}`,
          })
          return {
            ok: false,
            code: 'provisioning_failed',
            error: `The invitation is saved but the email could not be sent (${error.message}). Use Share link, or retry.`,
          }
        }
      } else {
        authUser = {
          id: data.user.id,
          email: canonicalEmail(data.user.email ?? email),
          confirmed: Boolean(data.user.email_confirmed_at),
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'auth lookup failed'
    await supabase.rpc('mark_invitation_failed', {
      p_invitation_id: invitationId,
      p_reason: reason,
    })
    return {
      ok: false,
      code: 'provisioning_failed',
      error: `The invitation is saved but Auth provisioning failed (${reason}). Retry converges safely.`,
    }
  }

  // STEP 3: finalize with TRUSTED Auth identity. Confirmed-with-no-company
  // becomes a direct add; new/unconfirmed stays pending until the person
  // authenticates and claims (no membership yet, by design).
  const { data: finalized, error: finErr } = await supabase.rpc('finalize_team_invitation', {
    p_invitation_id: invitationId,
    p_auth_user_id: authUser.id,
    p_auth_email: authUser.email,
    p_email_confirmed: authUser.confirmed,
  })
  if (finErr) {
    if (finErr.message.startsWith('existing_company_conflict')) {
      return conflictResult(finErr.message)
    }
    await supabase.rpc('mark_invitation_failed', {
      p_invitation_id: invitationId,
      p_reason: `finalize failed: ${finErr.message}`,
    })
    return {
      ok: false,
      code: 'provisioning_failed',
      error: `Invitation saved; finalisation failed (${finErr.message}). Retry converges safely.`,
    }
  }

  revalidatePath('/dashboard/team')
  return { ok: true, code: String(finalized) } // invited-pending_email | added_existing | already_member
}

/**
 * Share link: renews the DATABASE expiry first (a link must never point at
 * an expired lifecycle), then generates a fresh one-time Auth link WITHOUT
 * sending email (the built-in mailer allows ~2/hour). Returned once to the
 * verified admin; never stored or logged. Note: generateLink('invite')
 * behaviour for pre-existing Auth states is confirmed at runtime — any SDK
 * refusal surfaces as a typed, honest error rather than an assumption.
 */
export async function resendInvitation(input: { invitationId: string }): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()

  const { data: renewed, error: renewErr } = await supabase.rpc('renew_invitation', {
    p_invitation_id: input.invitationId,
  })
  if (renewErr) return { ok: false, code: 'renew_failed', error: renewErr.message }
  if (renewed !== 'renewed') {
    return {
      ok: false,
      code: String(renewed),
      error:
        renewed === 'revoked'
          ? 'That invitation was revoked; send a new one instead.'
          : 'That invitation was already accepted.',
    }
  }

  const { data: inv } = await supabase
    .from('invitations')
    .select('email')
    .eq('id', input.invitationId)
    .maybeSingle()
  if (!inv?.email) return { ok: false, code: 'not_found', error: 'Invitation not found.' }

  const adminClient = createServiceClient()
  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'invite',
    email: inv.email,
  })
  if (error || !data?.properties?.hashed_token) {
    return {
      ok: false,
      code: 'link_failed',
      error:
        error?.message ??
        'Could not generate a link for this account state. The person may need to sign in directly.',
    }
  }
  const shareLink = trustedAppUrl(
    `/auth/confirm?token_hash=${data.properties.hashed_token}&type=invite`,
  )
  if (!shareLink) {
    return {
      ok: false,
      code: 'site_url_missing',
      error: 'NEXT_PUBLIC_SITE_URL is not configured correctly.',
    }
  }
  revalidatePath('/dashboard/team')
  return { ok: true, code: 'link_generated', shareLink }
}

export async function revokeInvitation(input: { invitationId: string }): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('revoke_invitation', {
    p_invitation_id: input.invitationId,
  })
  if (error) return { ok: false, code: 'revoke_failed', error: error.message }
  revalidatePath('/dashboard/team')
  return { ok: true, code: String(data) }
}

export async function setMemberRole(input: {
  userId: string
  roleKey: string
}): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return gate
  if (!isInvitableRole(input.roleKey)) {
    return { ok: false, code: 'bad_role', error: 'That role cannot be granted here.' }
  }
  const supabase = await createClient()
  const { error } = await supabase.rpc('set_member_role', {
    p_company_id: gate.companyId,
    p_user_id: input.userId,
    p_role_key: input.roleKey,
  })
  if (error) {
    const friendly = error.message.includes('last_admin')
      ? 'You are the last active admin — appoint another admin first.'
      : error.message
    return { ok: false, code: 'role_failed', error: friendly }
  }
  revalidatePath('/dashboard/team')
  return { ok: true, code: 'role_changed' }
}

export async function setMembershipActive(input: {
  userId: string
  active: boolean
}): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return gate
  const supabase = await createClient()
  const { error } = await supabase.rpc('set_membership_active', {
    p_company_id: gate.companyId,
    p_user_id: input.userId,
    p_active: input.active,
  })
  if (error) {
    const friendly = error.message.includes('last_admin')
      ? 'You are the last active admin — appoint another admin first.'
      : error.message.startsWith('existing_company_conflict')
        ? 'That person is now active in another company; reactivation here is blocked.'
        : error.message
    return { ok: false, code: 'membership_failed', error: friendly }
  }
  revalidatePath('/dashboard/team')
  return { ok: true, code: input.active ? 'activated' : 'deactivated' }
}
