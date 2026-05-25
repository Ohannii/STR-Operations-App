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
  const { error } = await supabase.rpc('create_company_with_admin', {
    p_company_name: company_name,
  })

  if (error) {
    redirect(`/onboard?error=${encodeURIComponent(error.message)}`)
  }

  redirect('/dashboard')
}
