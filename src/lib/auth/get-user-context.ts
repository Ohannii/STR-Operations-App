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
 *
 * Multi-membership note: the schema permits a user to belong to multiple
 * companies (UNIQUE company_id+user_id is per pair). v1.0 UI is single-
 * company, so we deterministically pick the OLDEST active membership.
 * If the bootstrap accidentally creates duplicates (see the /onboard
 * action's idempotency check), we still return a usable context instead
 * of silently failing with PGRST116 from .maybeSingle().
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

  // Two small RLS-scoped reads in parallel.
  const profilePromise = supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', user.id)
    .maybeSingle()

  // Use order+limit instead of maybeSingle() so multiple matching rows
  // do not error out (PGRST116) and silently become null. The proper
  // long-term fix is a unique constraint / idempotent RPC; for v1.0 we
  // tolerate duplicates here.
  const membershipPromise = supabase
    .from('company_memberships')
    .select('company_id, role_key')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)

  const [{ data: profile }, { data: memberships, error: membershipError }] =
    await Promise.all([profilePromise, membershipPromise])

  if (membershipError) {
    // Visible in `pnpm dev` terminal. Not thrown — we want pages to still
    // render so the user can re-auth or see a clear empty state.
    console.error('[getUserContext] membership lookup error:', membershipError)
  }

  const membership = memberships?.[0] ?? null

  let company: UserContext['company'] = null
  if (membership) {
    const { data, error: companyError } = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', membership.company_id)
      .maybeSingle()
    if (companyError) {
      console.error('[getUserContext] company lookup error:', companyError)
    }
    company = data
  }

  return {
    user: { id: user.id, email: user.email ?? null },
    profile,
    membership,
    company,
  }
}
