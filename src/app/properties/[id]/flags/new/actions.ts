'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { maybeEnqueueFlagCreated } from '@/lib/integrations/outbox'
import { VALID_CHARGEABLE_VALUES } from '@/lib/ui/flag-status'
import { EVIDENCE_BUCKET } from '@/lib/photos/paths'
import { isUuid, validatePhotoDescriptors } from '@/lib/photos/finalize-helpers'

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
  // Optional short title. maxLength on the input guards normal entry;
  // slice(0, 80) is a defensive server-side cap (no error/redirect).
  const issueTitle = String(formData.get('issue_title') ?? '').trim().slice(0, 80)
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
      issue_title: issueTitle || null,
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

// ----------------------------------------------------------------
// finalizeFlagWithPhotos — new-flag capture with mandatory photos
// ----------------------------------------------------------------
//
// Slice 11B-1. The field-team flow: the client generated the flag id
// + photo ids, uploaded 1..5 compressed masters + thumbs to Storage,
// and now asks the server to atomically create the flag AND its photo
// rows. Photos are MANDATORY — the flag never reaches Asana until all
// of its photo rows are finalised.
//
// Order of operations (all server-authoritative):
//   1. Auth + resolve company from the property (never trusted).
//   2. Validate the photo descriptor list (1..5, valid UUIDs, no dupes).
//   3. Resolve category_id from category_key.
//   4. VERIFY every expected master + thumb object exists in Storage
//      before writing any rows — a failed/partial upload blocks submit.
//   5. finalize_flag_with_photos RPC: one transaction (flag + photos);
//      rolls back entirely on any error. The RPC itself derives
//      company_id, uploaded_by, retention_class and all storage paths —
//      this action passes NONE of those. Full-payload idempotency returns
//      'created' | 'already_finalized'.
//   6. Only AFTER the RPC succeeds (create OR idempotent replay) do we
//      maybeEnqueueFlagCreated → so Asana never sees a half-written flag.
//      Replay re-runs the enqueue in case a prior enqueue failed.
//
// This action never accepts or forwards company_id, uploaded_by,
// retention_class or storage paths from the client.
//
// Returns a small result object (not a redirect) so the 11B-2 client
// uploader can surface success/failure and navigate itself.

export type FinalizeFlagInput = {
  propertyId: string
  proposedFlagId: string
  categoryKey: string
  severity: string
  description: string
  issueTitle?: string | null
  accountability?: string | null
  photos: unknown
}

export type FinalizeFlagResult =
  | { ok: true; flagId: string; result: 'created' | 'already_finalized' }
  | { ok: false; error: string }

export async function finalizeFlagWithPhotos(
  input: FinalizeFlagInput,
): Promise<FinalizeFlagResult> {
  const ctx = await getUserContext()
  if (!ctx) return { ok: false, error: 'Not authenticated.' }
  if (!ctx.company) return { ok: false, error: 'No company context.' }

  const propertyId = String(input.propertyId ?? '').trim()
  const proposedFlagId = String(input.proposedFlagId ?? '').trim()
  const categoryKey = String(input.categoryKey ?? '').trim()
  const severity = String(input.severity ?? 'low').trim()
  const description = String(input.description ?? '').trim()
  const issueTitle = String(input.issueTitle ?? '').trim().slice(0, 80)
  const accountabilityRaw = String(input.accountability ?? '').trim()

  if (!propertyId) return { ok: false, error: 'Missing property reference.' }
  if (!isUuid(proposedFlagId)) return { ok: false, error: 'Invalid flag id.' }
  if (!categoryKey) return { ok: false, error: 'Pick an issue type.' }
  if (!description) return { ok: false, error: 'Description is required.' }
  if (description.length > 1000) {
    return { ok: false, error: 'Description is too long (max 1000 characters).' }
  }
  if (!['low', 'med', 'high'].includes(severity)) {
    return { ok: false, error: 'Invalid severity.' }
  }

  // Photos mandatory: 1..5, valid UUIDs, no duplicates (server-authoritative).
  const validation = validatePhotoDescriptors(input.photos)
  if (!validation.ok) return { ok: false, error: validation.error }
  const photos = validation.photos

  const accountability =
    accountabilityRaw &&
    accountabilityRaw !== 'needs_triage' &&
    VALID_CHARGEABLE_VALUES.includes(accountabilityRaw)
      ? accountabilityRaw
      : null

  const supabase = await createClient()

  // Parallel lookups: category (system seed) + property (RLS-scoped).
  const [
    { data: category, error: catErr },
    { data: property, error: propErr },
  ] = await Promise.all([
    supabase
      .from('flag_categories')
      .select('id')
      .eq('key', categoryKey)
      .is('company_id', null)
      .maybeSingle<{ id: string }>(),
    supabase
      .from('properties')
      .select('id, company_id')
      .eq('id', propertyId)
      .is('deleted_at', null)
      .maybeSingle<{ id: string; company_id: string }>(),
  ])

  if (catErr) {
    console.error('[flags/finalize] category lookup error:', catErr)
    return { ok: false, error: 'Could not look up issue type. Try again.' }
  }
  if (!category) return { ok: false, error: 'Unknown issue type.' }
  if (propErr) {
    console.error('[flags/finalize] property lookup error:', propErr)
    return { ok: false, error: propErr.message }
  }
  if (!property || property.company_id !== ctx.company.id) {
    return { ok: false, error: 'Property is not in your company.' }
  }

  // Verify every expected master + thumbnail object exists in Storage
  // BEFORE finalising — a failed/partial upload must block submit.
  const prefix = `companies/${ctx.company.id}/flags/${proposedFlagId}`
  const { data: objects, error: listErr } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .list(prefix, { limit: 100 })
  if (listErr) {
    console.error('[flags/finalize] storage list error:', listErr)
    return { ok: false, error: `Could not verify uploads: ${listErr.message}` }
  }
  const present = new Set((objects ?? []).map((o) => o.name))
  for (const p of photos) {
    if (!present.has(`${p.photoId}.jpg`) || !present.has(`${p.photoId}_thumb.jpg`)) {
      return {
        ok: false,
        error: 'Some photos have not finished uploading. Retry them and resubmit.',
      }
    }
  }

  // Transactional finalisation (flag + photos in one RPC transaction).
  const { data: rpcResult, error: rpcErr } = await supabase.rpc(
    'finalize_flag_with_photos',
    {
      p_flag_id: proposedFlagId,
      p_property_id: propertyId,
      p_category_id: category.id,
      p_severity: severity,
      p_description: description,
      p_issue_title: issueTitle || null,
      p_accountability: accountability,
      p_photos: photos.map((p) => ({
        photo_id: p.photoId,
        width: p.width,
        height: p.height,
        size_bytes: p.sizeBytes,
      })),
    },
  )

  if (rpcErr) {
    console.error('[flags/finalize] rpc error:', rpcErr)
    return { ok: false, error: `Could not finalise flag: ${rpcErr.message}` }
  }

  const result: 'created' | 'already_finalized' =
    rpcResult === 'already_finalized' ? 'already_finalized' : 'created'

  // Enqueue Asana ONLY after the flag + all photos are finalised
  // (create OR valid idempotent replay). Failure-isolated: never throws.
  await maybeEnqueueFlagCreated(supabase, {
    companyId: ctx.company.id,
    flagId: proposedFlagId,
    createdBy: ctx.user.id,
    payload: { property_id: propertyId, category_key: categoryKey },
  })

  revalidatePath('/dashboard')
  revalidatePath(`/properties/${propertyId}`)

  return { ok: true, flagId: proposedFlagId, result }
}
