'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import { formatDateTimeSAST } from '@/lib/ui/datetime'

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
    .insert({
      company_id: property.company_id,
      property_id: propertyId,
      pack_type: 'pre_arrival',
      status: 'draft',
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

  // Land on the Action Centre with capture_now=1 so the
  // EvidenceCapture modal auto-opens — Start pack flows straight
  // into the camera surface without a second tap.
  if (returnTo) {
    redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}capture_now=1`)
  }
  redirect(`/properties/${propertyId}?pack_started=1&capture_now=1`)
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
  if (pack.status !== 'draft') {
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent('Pack is already submitted.')}`)
  }

  const now = new Date().toISOString()
  const { error: updateErr } = await supabase
    .from('evidence_packs')
    .update({
      status: 'submitted',
      submitted_at: now,
      submitted_by: ctx.user.id,
    })
    .eq('id', packId)

  if (updateErr) {
    console.error('[packs/submit] update error:', updateErr)
    const url = returnTo ?? `/properties/${propertyId}`
    redirect(`${url}?error=${encodeURIComponent(updateErr.message)}`)
  }

  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: pack.company_id,
    actor_id: ctx.user.id,
    event_kind: 'evidence_pack_submit',
    entity_type: 'evidence_pack',
    entity_id: packId,
    before: { status: 'draft' },
    after: { status: 'submitted', submitted_at: now },
  })
  if (auditErr) {
    console.error('[packs/submit] audit write failed:', auditErr)
  }

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/packs/${packId}/report`)

  if (returnTo) redirect(returnTo)
  redirect(`/properties/${propertyId}?pack_submitted=1`)
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
