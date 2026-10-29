'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import { formatDateTimeSAST } from '@/lib/ui/datetime'
import { buildPackStartRedirect } from '@/lib/packs/start-redirect'
import {
  CONFLICT_UNPROVEN_MESSAGE,
  deriveConflictDetails,
  describeUnexpected,
  interpretCaptionSaveRpc,
  interpretSubmitRpc,
} from '@/lib/photos/caption-outcomes'
import type { SubmitActionResult } from '@/lib/photos/caption-submit'

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
// submitEvidencePackAction — LEGACY, now fail-closed for pre-arrival
// ----------------------------------------------------------------
//
// P0 caption durability (22 Oct 2026): this action finalised a pre-arrival
// pack WITHOUT the caption manifest — the exact Unit 377 incident shape. It
// now refuses pre-arrival finalisation outright and directs the user to the
// pack report's save-and-submit flow. Defence in depth: migration
// 20261022090000 also REVOKES the client grant on finalize_prearrival_pack,
// so even a direct/stale/manipulated POST (or raw RPC call) cannot finalise
// through this path. The idempotent already-submitted replay is kept so a
// stale form on an already-submitted pack still lands on a truthful success.
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
  // PRE-ARRIVAL: NEVER finalise here (P0 caption durability, 22 Oct 2026).
  // ----------------------------------------------------------------
  // Captions are part of the evidence; only the pack report's
  // submitPackWithCaptionsAction may finalise, because only it carries the
  // full caption manifest into one transaction. This runs BEFORE any other
  // pre-arrival handling so no code path below can reach finalisation.
  if (pack.pack_type === 'pre_arrival') {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(
      `${url}?error=${encodeURIComponent(
        'Pre-arrival packs are submitted from the pack report, where captions are saved with the pack. Open the report and tap "Save captions and submit pack".',
      )}`,
    )
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
// CAPTION DURABILITY (P0, 22 Oct 2026) — typed-result actions for the
// pack-report caption editor. These return structured results (no redirect)
// because the editor shows truthful inline states and must never lose a
// draft to a navigation. Raw database errors are LOGGED here and replaced
// with safe user-facing messages — they never reach a URL or the UI.
// ----------------------------------------------------------------

export type CaptionActionResult =
  | { ok: true; code: 'saved' | 'unchanged' }
  | {
      ok: false
      code?: 'stale'
      error: string
      retryable: boolean
      /** stale only: the server's CURRENT caption (undefined = unreadable). */
      serverNotes?: string | null
    }

function safeCaptionError(raw: string): { error: string; retryable: boolean } {
  if (raw.includes('caption_locked') || raw.includes('immutable')) {
    return {
      error: 'This pack was already submitted — captions can no longer change.',
      retryable: false,
    }
  }
  if (raw.includes('not an active photo')) {
    return { error: 'This photo is no longer part of the pack.', retryable: false }
  }
  if (raw.includes('too long')) {
    return { error: 'Caption is too long (max 2000 characters).', retryable: false }
  }
  return { error: 'Could not save the caption. It is still kept on this device.', retryable: true }
}

/**
 * Autosave ONE caption on a DRAFT pre-arrival pack (audited RPC).
 * COMPARE-AND-SET, ALWAYS (rev 4): `expectedNotes` — what the client believes
 * the server currently holds — is MANDATORY and the database compares it
 * unconditionally; there is no flag that could request a blind overwrite.
 * A missing or non-string expectation is rejected before any database call.
 * FAIL CLOSED: only 'saved' / 'unchanged' are success; 'stale' is a typed
 * conflict carrying the server's current caption; null or any other value is
 * logged server-side and returned as a safe failure.
 */
export async function saveDraftPhotoCaptionAction(input: {
  photoId: string
  note: string
  expectedNotes: string
}): Promise<CaptionActionResult> {
  const photoId = String(input?.photoId ?? '').trim()
  if (typeof input?.note !== 'string' || typeof input?.expectedNotes !== 'string') {
    return {
      ok: false,
      error: 'Caption could not be read. It is still kept on this device.',
      retryable: false,
    }
  }
  const note = input.note
  const expectedNotes = input.expectedNotes
  if (!photoId) return { ok: false, error: 'Missing photo reference.', retryable: false }
  if (note.length > 2000 || expectedNotes.length > 2000) {
    return { ok: false, error: 'Caption is too long (max 2000 characters).', retryable: false }
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'You appear to be signed out. Log in again.', retryable: false }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('set_prearrival_photo_caption', {
    p_photo_id: photoId,
    p_note: note,
    p_expected_notes: expectedNotes,
  })
  if (error) {
    console.error('[packs/caption] rpc error:', error)
    const safe = safeCaptionError(error.message ?? '')
    return { ok: false, ...safe }
  }
  const outcome = interpretCaptionSaveRpc(data)
  if (outcome.kind === 'saved') return { ok: true, code: 'saved' }
  if (outcome.kind === 'unchanged') return { ok: true, code: 'unchanged' }
  if (outcome.kind === 'stale') {
    // Read the server's CURRENT caption so the conflict can show both
    // versions and let the user choose (RLS-scoped read).
    let serverNotes: string | null | undefined
    const { data: row, error: readErr } = await supabase
      .from('photos')
      .select('notes')
      .eq('id', photoId)
      .maybeSingle<{ notes: string | null }>()
    if (!readErr && row) serverNotes = row.notes
    else if (readErr) console.error('[packs/caption] stale re-read failed:', readErr)
    return {
      ok: false,
      code: 'stale',
      error:
        'This caption was changed from another tab or device. Your text here is kept — choose which version to keep.',
      retryable: false,
      serverNotes,
    }
  }
  console.error('[packs/caption] unexpected rpc result:', describeUnexpected(data))
  return {
    ok: false,
    error: 'Could not confirm the caption was saved. It is still kept on this device.',
    retryable: false,
  }
}

export type SubmitWithCaptionsResult = SubmitActionResult

type ManifestPhotoRow = { id: string; notes: string | null }
type PackStateRow = { id: string; status: string }

/**
 * ONE "Save captions and submit pack" operation. The COMPLETE caption
 * manifest — each entry with the server BASELINE it was written against —
 * travels into a single SECURITY DEFINER transaction
 * (submit_prearrival_pack_with_captions), which validates the whole manifest
 * and every baseline under lock BEFORE writing anything, then saves,
 * audits and finalises. FAIL CLOSED (rev 3): only 'submitted' /
 * 'already_submitted' are success; 'caption_conflict' is a typed failure
 * (zero writes) that names the conflicting photos; null or anything else is
 * logged and returned as a safe failure. The pack stays a draft on failure.
 */
export async function submitPackWithCaptionsAction(input: {
  propertyId: string
  packId: string
  captions: Array<{ photoId: string; note: string; expected: string }>
}): Promise<SubmitWithCaptionsResult> {
  const propertyId = String(input?.propertyId ?? '').trim()
  const packId = String(input?.packId ?? '').trim()
  const captions = Array.isArray(input?.captions) ? input.captions : null
  if (!propertyId || !packId || !captions) {
    return { ok: false, error: 'Missing pack reference.' }
  }
  if (captions.length > 500) {
    return { ok: false, error: 'Too many captions in one submission. Nothing was submitted.' }
  }
  for (const c of captions) {
    if (
      !c ||
      typeof c.photoId !== 'string' ||
      typeof c.note !== 'string' ||
      typeof c.expected !== 'string'
    ) {
      return { ok: false, error: 'Captions could not be read. Nothing was submitted.' }
    }
    if (c.note.length > 2000 || c.expected.length > 2000) {
      return { ok: false, error: 'A caption is too long (max 2000 characters). Nothing was submitted.' }
    }
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'You appear to be signed out. Log in again.' }
  }

  const supabase = await createClient()

  // The pack must belong to the property in the URL (RLS scopes company).
  const { data: pack, error: readErr } = await supabase
    .from('evidence_packs')
    .select('id, property_id')
    .eq('id', packId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; property_id: string }>()
  if (readErr) {
    console.error('[packs/submit-captions] read error:', readErr)
    return { ok: false, error: 'Could not verify the pack. It is still a draft — try again.' }
  }
  if (!pack || pack.property_id !== propertyId) {
    return { ok: false, error: 'Pack not found for this property. Nothing was submitted.' }
  }

  const payload = captions.map((c) => ({
    photo_id: c.photoId,
    note: c.note,
    expected_note: c.expected,
  }))
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    'submit_prearrival_pack_with_captions',
    { p_pack_id: packId, p_captions: payload },
  )
  if (rpcErr) {
    console.error('[packs/submit-captions] rpc error:', rpcErr)
    const raw = rpcErr.message ?? ''
    const safe = raw.includes('not an active photo') || raw.includes('caption_manifest_incomplete')
      ? 'The photos in this pack changed while you were editing. Reload the report and try again — nothing was submitted, the pack is still a draft.'
      : raw.includes('unresolved')
        ? 'Some photos are still uploading. Wait for them to finish — the pack is still a draft.'
        : raw.includes('could not be verified against storage') || raw.includes('verified upload path')
          ? 'Some photos could not be verified. The pack is still a draft — use the recovery panel, then try again.'
          : raw.includes('no saved photos')
            ? 'This pack has no saved photos yet. The pack is still a draft.'
            : 'The pack could not be submitted. It is still a draft and your captions are kept on this device.'
    return { ok: false, error: safe }
  }

  const outcome = interpretSubmitRpc(rpcData)
  if (outcome.kind === 'caption_conflict') {
    // ZERO writes happened. Re-read and PROVE which photos differ; both read
    // errors are inspected and an inexact photo set is never guessed at.
    const ids = captions.map((c) => c.photoId)
    const [photosRead, packRead] = await Promise.all([
      supabase.from('photos').select('id, notes').in('id', ids).returns<ManifestPhotoRow[]>(),
      supabase
        .from('evidence_packs')
        .select('id, status')
        .eq('id', packId)
        .maybeSingle<PackStateRow>(),
    ])
    const details = deriveConflictDetails(
      captions,
      { data: photosRead.data, error: photosRead.error },
      { data: packRead.data, error: packRead.error },
    )
    revalidatePath(`/properties/${propertyId}`)
    revalidatePath(`/properties/${propertyId}/packs/${packId}/report`)
    if (details.kind === 'unproven') {
      // Generic, safe, reload-oriented failure: NOT the resolvable-conflict
      // path, so the editor keeps every draft and shows no empty choice UI.
      console.error('[packs/submit-captions] conflict details unproven:', details.reason)
      return { ok: false, error: CONFLICT_UNPROVEN_MESSAGE }
    }
    return {
      ok: false,
      code: 'caption_conflict',
      packSubmitted: details.packSubmitted,
      conflicts: details.conflicts,
      error: details.packSubmitted
        ? 'This pack was already submitted from another device with different captions. ' +
          'Your typed captions were NOT saved into it — they are kept on this device. ' +
          'Copy them below if you need them.'
        : 'Some captions were changed from another tab or device since you last saved. ' +
          'Nothing was submitted and the pack is still a draft — choose which version to keep for the highlighted photos.',
    }
  }
  if (outcome.kind === 'unknown') {
    console.error('[packs/submit-captions] unexpected rpc result:', describeUnexpected(rpcData))
    return {
      ok: false,
      error:
        'The submission could not be confirmed. Reload the report to check whether the pack is still a draft — your captions are kept on this device.',
    }
  }

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/packs/${packId}/report`)
  return { ok: true, code: outcome.kind }
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
