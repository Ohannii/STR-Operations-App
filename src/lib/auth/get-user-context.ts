import { createClient } from '@/lib/supabase/server'

/**
 * Bundle of the things every authenticated page needs to know:
 * who is the user, where is their profile, and which company are they in
 * (if any).
 *
 * Pages use this to decide "are you logged in? do you have a company yet?"
 * without making each page write the same three queries.
 *
 * Returns null when there is no logged-in user — caller redirects to /login.
 */

export type UserContext = {
  user: {
    id: string
    email: string | null
  }
  profile: {
    id: string
    full_name: string | null
    email: string | null
  } | null
  membership: {
    company_id: string
    role_key: string
  } | null
  company: {
    id: string
    name: string
  } | null
}

export async function getUserContext(): Promise<UserContext | null> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // Three small RLS-scoped reads. Run in parallel where independent.
  const profilePromise = supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', user.id)
    .maybeSingle()

  const membershipPromise = supabase
    .from('company_memberships')
    .select('company_id, role_key')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle()

  const [{ data: profile }, { data: membership }] = await Promise.all([
    profilePromise,
    membershipPromise,
  ])

  let company: UserContext['company'] = null
  if (membership) {
    const { data } = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', membership.company_id)
      .maybeSingle()
    company = data
  }

  return {
    user: { id: user.id, email: user.email ?? null },
    profile,
    membership,
    company,
  }
}
