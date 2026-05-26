'use server'

import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'

/**
 * Server action invoked by the raise-flag form at
 * /properties/[id]/flags/new.
 *
 * Validates input, looks up the flag_category_id from the chosen key
 * (system seed; publicly readable), and inserts a new row in `flags`
 * with status = 'raised'. RLS enforces company scope; the
 * "members insert flags in own company" policy plus the matching
 * GRANT INSERT on the flags table do the heavy lifting.
 *
 * Errors flow back via ?error= query string with the chosen category
 * preserved so the user doesn't have to re-pick after a typo.
 */
export async function createFlagAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const categoryKey = String(formData.get('category_key') ?? '').trim()
  const severity = String(formData.get('severity') ?? 'low').trim()
  const description = String(formData.get('description') ?? '').trim()

  const formUrl = `/properties/${propertyId}/flags/new?category=${encodeURIComponent(categoryKey)}`

  if (!propertyId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing property reference.')}`)
  }
  if (!categoryKey) {
    redirect(`/properties/${propertyId}/flags/new?error=${encodeURIComponent('Pick a flag type.')}`)
  }
  if (!description) {
    redirect(`${formUrl}&error=${encodeURIComponent('Description is required.')}`)
  }
  if (description.length > 1000) {
    redirect(`${formUrl}&error=${encodeURIComponent('Description is too long (max 1000 characters).')}`)
  }
  if (!['low', 'med', 'high'].includes(severity)) {
    redirect(`${formUrl}&error=${encodeURIComponent('Invalid severity.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  // Look up the flag_category by key. The seed rows have
  // company_id IS NULL; the "anyone reads system flag_categories"
  // policy lets us read them.
  const { data: category, error: catErr } = await supabase
    .from('flag_categories')
    .select('id')
    .eq('key', categoryKey)
    .is('company_id', null)
    .maybeSingle()

  if (catErr) {
    console.error('[flags/new] category lookup error:', catErr)
    redirect(`${formUrl}&error=${encodeURIComponent('Could not look up flag type. Try again.')}`)
  }
  if (!category) {
    redirect(`${formUrl}&error=${encodeURIComponent('Unknown flag type.')}`)
  }

  // Resolve the property's company_id so we satisfy the
  // is_company_member() check in the INSERT policy. RLS already
  // scopes the SELECT, so a wrong-company id returns null and we
  // bounce.
  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, company_id')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle()

  if (propErr) {
    console.error('[flags/new] property lookup error:', propErr)
    redirect(`${formUrl}&error=${encodeURIComponent(propErr.message)}`)
  }
  if (!property) {
    redirect(`/dashboard?error=${encodeURIComponent('Property not found.')}`)
  }

  const { error: insertErr } = await supabase.from('flags').insert({
    company_id: property.company_id,
    property_id: property.id,
    flag_category_id: category.id,
    status: 'raised',
    severity,
    description,
    raised_by: ctx.user.id,
  })

  if (insertErr) {
    console.error('[flags/new] insert error:', insertErr)
    redirect(`${formUrl}&error=${encodeURIComponent(`Could not raise flag: ${insertErr.message}`)}`)
  }

  redirect(`/properties/${property.id}?raised=1`)
}
