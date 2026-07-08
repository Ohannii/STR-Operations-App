'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { maybeEnqueueFlagCreated } from '@/lib/integrations/outbox'
import { VALID_CHARGEABLE_VALUES } from '@/lib/ui/flag-status'

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
 * Performance: the category lookup and the property lookup are
 * independent — we run them in parallel rather than sequentially.
 *
 * Errors flow back via ?error= query string with the chosen category
 * preserved so the user doesn't have to re-pick after a typo.
 */
export async function createFlagAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const categoryKey = String(formData.get('category_key') ?? '').trim()
  const severity = String(formData.get('severity') ?? 'low').trim()
  const description = String(formData.get('description') ?? '').trim()
  const accountabilityRaw = String(formData.get('chargeable_party_decision') ?? '').trim()

  const formUrl = `/properties/${propertyId}/flags/new?category=${encodeURIComponent(categoryKey)}`

  if (!propertyId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing property reference.')}`)
  }
  if (!categoryKey) {
    redirect(`/properties/${propertyId}/flags/new?error=${encodeURIComponent('Pick an issue type.')}`)
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

  // Parallel lookups: category-by-key (publicly readable system seed)
  // and the target property (RLS scopes it to the user's company).
  const [
    { data: category, error: catErr },
    { data: property, error: propErr },
  ] = await Promise.all([
    supabase
      .from('flag_categories')
      .select('id')
      .eq('key', categoryKey)
      .is('company_id', null)
      .maybeSingle(),
    supabase
      .from('properties')
      .select('id, company_id')
      .eq('id', propertyId)
      .is('deleted_at', null)
      .maybeSingle(),
  ])

  if (catErr) {
    console.error('[flags/new] category lookup error:', catErr)
    redirect(`${formUrl}&error=${encodeURIComponent('Could not look up issue type. Try again.')}`)
  }
  if (!category) {
    redirect(`${formUrl}&error=${encodeURIComponent('Unknown issue type.')}`)
  }

  if (propErr) {
    console.error('[flags/new] property lookup error:', propErr)
    redirect(`${formUrl}&error=${encodeURIComponent(propErr.message)}`)
  }
  if (!property) {
    redirect(`/dashboard?error=${encodeURIComponent('Property not found.')}`)
  }

  // Optional preliminary accountability. Persist null when the reporter
  // left the default ("Not sure / needs triage") so "not yet decided"
  // stays null; only store an explicit choice. Invalid values → null.
  const accountability =
    accountabilityRaw &&
    accountabilityRaw !== 'needs_triage' &&
    VALID_CHARGEABLE_VALUES.includes(accountabilityRaw)
      ? accountabilityRaw
      : null

  const { data: newFlag, error: insertErr } = await supabase
    .from('flags')
    .insert({
      company_id: property.company_id,
      property_id: property.id,
      flag_category_id: category.id,
      status: 'raised',
      severity,
      description,
      chargeable_party_decision: accountability,
      raised_by: ctx.user.id,
    })
    .select('id')
    .single()

  if (insertErr) {
    console.error('[flags/new] insert error:', insertErr)
    redirect(`${formUrl}&error=${encodeURIComponent(`Could not report issue: ${insertErr.message}`)}`)
  }

  // Slice 4b: outbound Asana handoff. Gated by the per-company feature
  // flag (OFF by default) and fully failure-isolated — maybeEnqueue
  // never throws, so a queue problem can never break issue reporting.
  // NOTE: this runs BEFORE redirect() so the redirect signal is never
  // swallowed by any try/catch.
  if (newFlag) {
    await maybeEnqueueFlagCreated(supabase, {
      companyId: property.company_id,
      flagId: newFlag.id,
      createdBy: ctx.user.id,
      payload: { property_id: property.id, category_key: categoryKey },
    })
  }

  // Keep the company dashboard's "Open flags" count in sync — it's
  // a separate route from the apartment page and won't refresh on
  // its own after a flag is raised.
  revalidatePath('/dashboard')
  revalidatePath(`/properties/${property.id}`)

  redirect(`/properties/${property.id}?raised=1`)
}
