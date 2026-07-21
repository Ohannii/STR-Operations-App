'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import { formatDateTimeSAST } from '@/lib/ui/datetime'
import { evaluatePackSubmit, parseExpectedCount } from '@/lib/packs/submit-guard'
import { buildPackStartRedirect } from '@/lib/packs/start-redirect'

/**
 * Evidence-pack lifecycle server actions.
 *
 * A pack is a thin container that groups one turnover's worth of
 * pre-arrival photos. Only TWO states matter at v1.0:
 *
 *   draft       — the pack is in flight; staff add photos to it.
 *                 At most one draft pack per (property, type)
 *                 exists at a time (DB partial unique index).
 *   submitted   — staff has signed off. Pack is read-only from the
 *                 UI's standpoint (we don't enforce immutability
 *                 at the DB layer; admin tools / future audit-
 *                 reopens can update if needed).
 *
 * Submitted packs land in the property's history. A new draft can
 * then be started for the next turnover.
 *
 * These actions are deliberately separate from the photo-upload
 * pipeline (src/app/properties/[id]/photos/actions.ts) — packs
 * own lifecycle, photos own bytes. The two layers join via
 * photos.evidence_pack_id, which the upload pipeline writes when
 * a photo is captured under an open pack.
 */

// ----------------------------------------------------------------
// startPreArrivalPack — create a draft pack
// ----------------------------------------------------------------
//
// Standard form-action shape: takes propertyId + optional title +
// optional notes, opens a draft pack, redirects back to the Action
// Centre. The DB partial unique index on (property_id, pack_type)
// where status='draft' prevents two drafts from existing
// simultaneously. If we hit that race, surface a sensible error.
export async function startPreArrivalPackAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const titleRaw = String(formData.get('title') ?? '').trim()
  const notesRaw = String(formData.get('notes') ?? '').trim()
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)

  if (!propertyId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing property reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()

  // Confirm the property is visible to the caller. RLS does the
  // real scope check; this also gives us the company_id we need.
  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, company_id')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string }>()

  if (propErr || !property) {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(propErr?.message ?? 'Property not found.')}`)
  }

  // Default title: "Pre-arrival pack — 20 Jun 2026, 15:59" in SAST so
  // the auto-title matches the team's wall clock (DB + Vercel server
  // are UTC). See @/lib/ui/datetime.
  const now = new Date()
  const defaultTitle = `Pre-arrival pack — ${formatDateTimeSAST(now)}`

  const title = titleRaw.length > 0 ? titleRaw.slice(0, 200) : defaultTitle
  const notes = notesRaw.length > 0 ? notesRaw.slice(0, 2000) : null

  const { data: pack, error: insertErr } = await supabase
    .from('evidence_packs')
    // NOTE: `status` is deliberately NOT named here. Migration
    // 20260718120000 removed the client's column privilege on status /
    // submitted_at / submitted_by so a pack can never be created or moved
    // into 'submitted' from the client. Naming a column you cannot write
    // fails even when the value is the default, so we let the column
    // default supply 'draft' — identical result, no privilege needed.
    .insert({
      company_id: property.company_id,
      property_id: propertyId,
      pack_type: 'pre_arrival',
      title,
      notes,
      started_by: ctx.user.id,
    })
    .select('id')
    .maybeSingle<{ id: string }>()

  if (insertErr || !pack) {
    // Partial unique index throws code 23505. Translate to a
    // human message.
    const msg =
      insertErr?.code === '23505'
        ? 'A draft pre-arrival pack already exists. Open it or submit it before starting a new one.'
        : insertErr?.message ?? 'Could not create pack.'
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(msg)}`)
  }

  // Audit
  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: property.company_id,
    actor_id: ctx.user.id,
    event_kind: 'evidence_pack_start',
    entity_type: 'evidence_pack',
    entity_id: pack.id,
    metadata: { property_id: propertyId, pack_type: 'pre_arrival', title },
  })
  if (auditErr) {
    console.error('[packs/start] audit write failed:', auditErr)
  }

  revalidatePath(`/properties/${propertyId}`)

  // NO capture_now: camera auto-open is removed entirely (P0, 21 Jul 2026).
  // See buildPackStartRedirect for the invariant and its regression test.
  redirect(buildPackStartRedirect(propertyId, returnTo))
}


// ----------------------------------------------------------------
// submitEvidencePackAction — flip draft → submitted
// ----------------------------------------------------------------
//
// One-tap finalise. We do NOT require photos to exist — an empty
// submitted pack is unusual but legitimate (e.g., apartment looked
// fine, no documentation needed). The UI gates this on the user
// side with a confirm dialog, not the server.
export async function submitEvidencePackAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const packId = String(formData.get('pack_id') ?? '').trim()
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)

  if (!propertyId || !packId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing pack reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()

  // Verify pack belongs to this property + is currently a draft.
  const { data: pack, error: readErr } = await supabase
    .from('evidence_packs')
    .select('id, status, pack_type, property_id, company_id')
    .eq('id', packId)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      status: string
      pack_type: string
      property_id: string
      company_id: string
    }>()

  if (readErr) {
    console.error('[packs/submit] read error:', readErr)
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(readErr.message)}`)
  }
  if (!pack) {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack not found.')}`)
  }
  if (pack.property_id !== propertyId) {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack does not belong to this property.')}`)
  }
  if (pack.status === 'submitted') {
    // Idempotent submit: a lost response or a duplicate click lands here.
    // The pack is already submitted — treat it as SUCCESS (don't create
    // anything, don't show a misleading destructive error).
    if (returnTo) redirect(returnTo)
    redirect(`/properties/${propertyId}?pack_submitted=1`)
  }
  if (pack.status !== 'draft') {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack is in an unexpected state and was not submitted.')}`)
  }

  // ----------------------------------------------------------------
  // FAIL-CLOSED PHOTO GUARD (fix/prearrival-photo-submit-guard)
  // ----------------------------------------------------------------
  // Scoped to the pre-arrival workflow. Never let a pre-arrival pack
  // become `submitted` while it has zero active linked photos, or
  // fewer than the client says it expected (partial-upload race). This
  // is server-authoritative — it runs regardless of the client's
  // disabled button, so a direct/stale/duplicate/manipulated request
  // is rejected too. On failure the pack stays a draft and we redirect
  // back with a useful error (never a fake success). The count query is
  // company-scoped by RLS, filtered to this pack, and excludes
  // soft-deleted rows, so deleted photos can't satisfy the requirement.
  if (pack.pack_type === 'pre_arrival') {
    const { count: linkedCount, error: countErr } = await supabase
      .from('photos')
      .select('id', { count: 'exact', head: true })
      .eq('evidence_pack_id', packId)
      .is('deleted_at', null)

    if (countErr) {
      console.error('[packs/submit] photo count error:', countErr)
      const url = returnTo ?? `/properties/${propertyId}`
      redirect(
        `${url}?error=${encodeURIComponent(
          'Could not verify the pack photos. It is still a draft — please try again.',
        )}`,
      )
    }

    const decision = evaluatePackSubmit({
      linkedActivePhotoCount: linkedCount ?? 0,
      expected: parseExpectedCount(formData.get('expected_count')),
    })
    if (!decision.ok) {
      const url = returnTo ?? `/properties/${propertyId}`
      redirect(`${url}?error=${encodeURIComponent(decision.message)}`)
    }
  }

  // ----------------------------------------------------------------
  // AUTHORITATIVE FINALISE (Outcome 2)
  // ----------------------------------------------------------------
  // The RPC locks the pack and proves the whole invariant in ONE
  // transaction: no unresolved intents, every completed intent has its exact
  // active photos row AND Storage objects, at least one active photo — then
  // flips draft -> submitted. No client-supplied count is trusted; the
  // expected_count check above is only a fast, non-authoritative pre-check
  // retained from Outcome 1. An already-submitted pack replays idempotently.
  if (pack.pack_type === 'pre_arrival') {
    const { data: outcome, error: rpcErr } = await supabase.rpc(
      'finalize_prearrival_pack',
      { p_pack_id: packId },
    )
    if (rpcErr) {
      console.error('[packs/submit] finalize rpc error:', rpcErr)
      const url = returnTo ?? `/properties/${propertyId}`
      redirect(`${url}?error=${encodeURIComponent(rpcErr.message)}`)
    }

    const { error: auditErr } = await supabase.from('audit_events').insert({
      company_id: pack.company_id,
      actor_id: ctx.user.id,
      event_kind: 'evidence_pack_submit',
      entity_type: 'evidence_pack',
      entity_id: packId,
      before: { status: 'draft' },
      after: { status: 'submitted', outcome },
    })
    if (auditErr) {
      console.error('[packs/submit] audit write failed:', auditErr)
    }

    revalidatePath(`/properties/${propertyId}`)
    revalidatePath(`/properties/${propertyId}/packs/${packId}/report`)
    if (returnTo) redirect(returnTo)
    redirect(`/properties/${propertyId}?pack_submitted=1`)
  }

  // Any OTHER pack type. Since migration 20260718120000 the client no longer
  // holds the column privilege to write `status`, so a direct transition is
  // impossible by design — only a SECURITY DEFINER finalise RPC can do it, and
  // only pre-arrival has one today. Fail with a clear message rather than a
  // confusing "permission denied for table evidence_packs".
  console.error('[packs/submit] unsupported pack_type:', pack.pack_type)
  const url = returnTo ?? `/properties/${propertyId}`
  redirect(
    `${url}?error=${encodeURIComponent(
      `Submitting a "${pack.pack_type}" pack is not supported yet.`,
    )}`,
  )
}


// ----------------------------------------------------------------
// recoverPrearrivalPhotoIntentAction — rescue already-uploaded bytes
// ----------------------------------------------------------------
//
// If the images reached Storage but the attach response was lost (tab closed,
// device reloaded, network died at the wrong moment), the evidence EXISTS.
// This completes the intent from Storage alone — no device file required — so
// an inspector is never sent back to a property whose photos are already
// stored. If the bytes really are absent the RPC says so, and the only
// remaining option is recapture or an audited exclusion.
export async function recoverPrearrivalPhotoIntentAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const photoId = String(formData.get('photo_id') ?? '').trim()
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)
  const url = returnTo ?? `/properties/${propertyId}`

  if (!propertyId || !photoId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing photo reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()
  const { error } = await supabase.rpc('recover_prearrival_photo_intent', {
    p_photo_id: photoId,
  })
  if (error) {
    console.error('[packs/recover-intent] rpc error:', error)
    redirect(`${url}?error=${encodeURIComponent(error.message)}`)
  }

  revalidatePath(`/properties/${propertyId}`)
  redirect(`${url}?intent_recovered=1`)
}


// ----------------------------------------------------------------
// discardPrearrivalPhotoIntentAction — audited abandon of ONE photo
// ----------------------------------------------------------------
//
// The only sanctioned way to clear an unresolved (pending) upload intent that
// can no longer be retried — e.g. the browser was closed and the in-memory
// image is gone. A REASON IS REQUIRED and is stored with the actor and
// timestamp by the RPC. Completed photos can never be discarded here, and no
// Storage evidence is deleted. The inspector is told the photo must be
// recaptured or deliberately excluded.
export async function discardPrearrivalPhotoIntentAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const photoId = String(formData.get('photo_id') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim()
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)
  const url = returnTo ?? `/properties/${propertyId}`

  if (!propertyId || !photoId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing photo reference.')}`)
  }
  if (!reason) {
    redirect(
      `${url}?error=${encodeURIComponent(
        'A reason is required to exclude a missing photo.',
      )}`,
    )
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()
  const { error } = await supabase.rpc('discard_prearrival_photo_intent', {
    p_photo_id: photoId,
    p_reason: reason,
  })
  if (error) {
    console.error('[packs/discard-intent] rpc error:', error)
    redirect(`${url}?error=${encodeURIComponent(error.message)}`)
  }

  revalidatePath(`/properties/${propertyId}`)
  redirect(`${url}?intent_discarded=1`)
}


// ----------------------------------------------------------------
// discardEvidencePackAction — soft-delete a draft
// ----------------------------------------------------------------
//
// Only drafts can be discarded. Submitted packs are part of the
// history record and require a separate hard-delete path (not
// shipped — soft-delete only via deleted_at).
export async function discardEvidencePackAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const packId = String(formData.get('pack_id') ?? '').trim()
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)

  if (!propertyId || !packId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing pack reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()

  const { data: pack, error: readErr } = await supabase
    .from('evidence_packs')
    .select('id, status, property_id, company_id')
    .eq('id', packId)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      status: string
      property_id: string
      company_id: string
    }>()

  if (readErr) {
    console.error('[packs/discard] read error:', readErr)
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(readErr.message)}`)
  }
  if (!pack) {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack not found.')}`)
  }
  if (pack.property_id !== propertyId) {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack does not belong to this property.')}`)
  }
  if (pack.status !== 'draft') {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(
      `${url}?error=${encodeURIComponent('Submitted packs cannot be discarded.')}`,
    )
  }

  const { error: updateErr } = await supabase
    .from('evidence_packs')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', packId)

  if (updateErr) {
    console.error('[packs/discard] update error:', updateErr)
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(updateErr.message)}`)
  }

  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: pack.company_id,
    actor_id: ctx.user.id,
    event_kind: 'evidence_pack_discard',
    entity_type: 'evidence_pack',
    entity_id: packId,
    metadata: { property_id: propertyId },
  })
  if (auditErr) {
    console.error('[packs/discard] audit write failed:', auditErr)
  }

  revalidatePath(`/properties/${propertyId}`)

  if (returnTo) redirect(returnTo)
  redirect(`/properties/${propertyId}?pack_discarded=1`)
}
