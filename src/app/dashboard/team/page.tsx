import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { invitationStatus } from '@/lib/team/team-helpers'
import { TeamManager, type InvitationRow, type MemberRow } from './team-manager'

/**
 * /dashboard/team — PR-A. company_admin ONLY: the redirect below is UX; the
 * real enforcement is server-side in every action and inside the SECURITY
 * DEFINER functions (client-side hiding is not authorization).
 */
export default async function TeamPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (ctx.membership?.role_key !== 'company_admin') redirect('/dashboard')

  const supabase = await createClient()

  const [{ data: memberships }, { data: invitations }] = await Promise.all([
    supabase
      .from('company_memberships')
      .select('user_id, role_key, is_active, created_at, profiles ( full_name, email )')
      .eq('company_id', ctx.company.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    supabase
      .from('invitations')
      .select('id, email, role_key, created_at, expires_at, accepted_at, revoked_at, failed_reason')
      .eq('company_id', ctx.company.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
  ])

  const members: MemberRow[] = (memberships ?? []).map((m) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
    return {
      userId: m.user_id as string,
      name: (profile?.full_name as string | null) ?? null,
      email: (profile?.email as string | null) ?? null,
      roleKey: m.role_key as string,
      isActive: m.is_active as boolean,
      isSelf: m.user_id === ctx.user.id,
    }
  })

  const memberEmails = new Set(members.map((m) => (m.email ?? '').toLowerCase()))
  const pendingInvitations: InvitationRow[] = (invitations ?? [])
    .map((i) => ({
      id: i.id as string,
      email: i.email as string,
      roleKey: i.role_key as string,
      status: invitationStatus({
        revokedAt: i.revoked_at as string | null,
        acceptedAt: i.accepted_at as string | null,
        expiresAt: i.expires_at as string | null,
        failedReason: i.failed_reason as string | null,
      }),
    }))
    // Accepted invites show as members already; list the rest.
    .filter((i) => i.status !== 'accepted' && !memberEmails.has(i.email.toLowerCase()))

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold text-slate-900">Team</h1>
      <p className="mt-1 text-sm text-slate-600">
        Invite your team so flags, packs and photos are recorded under the right
        person. Only company admins can manage the team.
      </p>
      <TeamManager members={members} invitations={pendingInvitations} />
    </main>
  )
}
