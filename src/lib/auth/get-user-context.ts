import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

/**
 * Bundle of the things every authenticated page needs to know:
 * who is the user, where is their profile, and which company are they in
 * (if any).
 *
 * Pages use this to decide "are you logged in? do you have a company yet?"
 * without making each page write the same queries.
 *
 * Returns null when there is no logged-in user — caller redirects to /login.
 *
 * Performance: combines membership + company lookup into a single
 * PostgREST round-trip via an embed (companies!inner). Together with
 * the parallel profile query, an authenticated page sees one auth
 * call + one parallel pair of DB queries (down from one + parallel +
 * one sequential companies lookup).
 *
 * Multi-membership note: the schema permits a user to belong to
 * multiple companies. v1.0 UI is single-company, so we
 * deterministically pick the OLDEST active membership and ignore
 * the rest.
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

// Supabase's typed embed returns a single object for many-to-one,
// but the generic JS client without generated types gives us a
// loose shape. This tiny helper coerces it without using `any`.
type EmbeddedCompany = { id: string; name: string }

type MembershipRow = {
  company_id: string
  role_key: string
  companies: EmbeddedCompany | EmbeddedCompany[] | null
}

function pickEmbedded(value: EmbeddedCompany | EmbeddedCompany[] | null): EmbeddedCompany | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export const getUserContext = cache(async (): Promise<UserContext | null> => {
  // TEMPORARY perf diagnostics (Slice 11a-perf) — remove after measuring.
  const _t0 = performance.now()
  const supabase = await createClient()
  const _t1 = performance.now()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const _t2 = performance.now()
  if (!user) {
    console.log(
      `[perf][getUserContext] client=${(_t1 - _t0).toFixed(0)}ms getUser=${(_t2 - _t1).toFixed(0)}ms (no user)`,
    )
    return null
  }

  // Two parallel reads:
  //   - profile (own profile only)
  //   - membership embedded with company (one round trip)
  const profilePromise = supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', user.id)
    .maybeSingle()

  const membershipPromise = supabase
    .from('company_memberships')
    .select(
      `
      company_id,
      role_key,
      companies (
        id,
        name
      )
      `,
    )
    .eq('user_id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .returns<MembershipRow[]>()

  const [
    { data: profile },
    { data: memberships, error: membershipError },
  ] = await Promise.all([profilePromise, membershipPromise])
  console.log(
    `[perf][getUserContext] client=${(_t1 - _t0).toFixed(0)}ms getUser=${(_t2 - _t1).toFixed(0)}ms ctxQueries=${(performance.now() - _t2).toFixed(0)}ms`,
  )

  if (membershipError) {
    console.error('[getUserContext] membership lookup error:', membershipError)
  }

  const row = memberships?.[0] ?? null
  const membership = row
    ? { company_id: row.company_id, role_key: row.role_key }
    : null
  const company = pickEmbedded(row?.companies ?? null)

  return {
    user: { id: user.id, email: user.email ?? null },
    profile,
    membership,
    company,
  }
})
