'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'

/**
 * Server action invoked by the /properties/new form.
 *
 * Reads the caller's company_id from the user context, then inserts
 * the property. RLS double-checks that company_id matches a company
 * the caller is a member of — see the "members insert company properties"
 * policy in migration 20260525120000_auth_and_rls.sql.
 */
export async function createPropertyAction(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  const address = String(formData.get('address') ?? '').trim() || null
  const unit_reference = String(formData.get('unit_reference') ?? '').trim() || null
  const bedroomsStr = String(formData.get('bedrooms') ?? '').trim()
  const bedrooms = bedroomsStr ? Number(bedroomsStr) : null

  if (!name) {
    redirect(`/properties/new?error=${encodeURIComponent('Property name is required.')}`)
  }
  if (bedrooms != null && (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 50)) {
    redirect(`/properties/new?error=${encodeURIComponent('Bedrooms must be 0–50.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()
  const { error } = await supabase.from('properties').insert({
    company_id: ctx.company.id,
    name,
    address,
    unit_reference,
    bedrooms,
  })

  if (error) {
    redirect(`/properties/new?error=${encodeURIComponent(error.message)}`)
  }

  redirect('/dashboard')
}
