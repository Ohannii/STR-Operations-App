'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import {
  EVIDENCE_BUCKET,
  masterStoragePath,
  thumbStoragePath,
  type StorageContext,
} from '@/lib/photos/paths'
import {
  PRE_ARRIVAL_RETENTION,
  retentionClassForFlagCategory,
  type RetentionClass,
} from '@/lib/photos/retention'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'

/**
 * Evidence photo server actions.
 *
 * The upload pipeline is two-phase to keep bytes off the Next.js
 * server: the client compresses + thumbnails locally, asks the
 * server for short-lived signed upload URLs, PUTs both blobs
 * directly to Supabase Storage, then asks the server to record
 * the metadata row in public.photos.
 *
 * Why server actions and not Route Handlers:
 *   - These all return small JSON payloads (or perform redirects),
 *     so the call shape is symmetric with the rest of this codebase.
 *   - Server actions are awaitable as async functions from client
 *     components when imported, which is what the EvidenceCapture
 *     client component does.
 *
 * Authority: every action re-fetches the flag (when applicable)
 * with the user's session, so RLS double-checks scope on top of
 * the SECURITY DEFINER is_company_member() check inside the storage
 * trigger. No service_role anywhere.
 */

// ----------------------------------------------------------------
// Types — small JSON return shapes for the client uploader.
// ----------------------------------------------------------------

export type UploadSlot = {
  ok: true
  photoId: string
  masterPath: string
  thumbPath: string
  masterUpload: { signedUrl: string; token: string }
  thumbUpload: { signedUrl: string; token: string }
  /** Server-derived class so the client cannot lie about retention. */
  retentionClass: RetentionClass
  /** Echoed back so the attach call carries the same context. */
  companyId: string
  /** Echo of the validated pack id when this is a pre-arrival capture. */
  evidencePackId: string | null
}

export type UploadSlotError = {
  ok: false
  error: string
}

// ----------------------------------------------------------------
// requestPhotoUploadSlot — phase 1 of upload
// ----------------------------------------------------------------
//
// Returns short-lived signed upload URLs that the browser uses to
// PUT the master and thumb directly to Supabase Storage. The
// session cookie still scopes the underlying createSignedUploadUrl
// call so we never need service_role.
//
// Scope checks:
//   - Caller must be a company member (RLS-enforced via the
//     property read below).
//   - If flagId is provided, the flag must belong to the same
//     property and not be soft-deleted.

export async function requestPhotoUploadSlot(input: {
  propertyId: string
  flagId?: string | null
  /**
   * Session 8 follow-up: pre-arrival photos are scoped to an
   * evidence pack. When the caller is the pre-arrival capture
   * surface, packId must be supplied; the server validates the
   * pack is a draft on this property before signing. Flag-photo
   * captures don't carry a packId.
   */
  evidencePackId?: string | null
}): Promise<UploadSlot | UploadSlotError> {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'Not authenticated.' }
  }

  const propertyId = String(input.propertyId ?? '').trim()
  const flagId = input.flagId ? String(input.flagId).trim() : null
  const evidencePackId = input.evidencePackId
    ? String(input.evidencePackId).trim()
    : null

  if (!propertyId) {
    return { ok: false, error: 'Missing property reference.' }
  }

  const supabase = await createClient()

  // Verify property is visible to the caller (RLS does the real
  // check; we just need confirmation it exists for this user).
  const { data: property, error: propertyErr } = await supabase
    .from('properties')
    .select('id, company_id')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string }>()

  if (propertyErr) {
    console.error('[photos/sign] property read error:', propertyErr)
    return { ok: false, error: propertyErr.message }
  }
  if (!property) {
    return { ok: false, error: 'Property not found.' }
  }
  if (property.company_id !== ctx.company.id) {
    // Belt-and-braces. RLS should already prevent this read.
    return { ok: false, error: 'Property is not in your company.' }
  }

  // If this is a flag capture, verify the flag and derive
  // retention class from its category. PostgREST embed gives us
  // the category key in one round trip.
  let retentionClass: RetentionClass = PRE_ARRIVAL_RETENTION
  if (flagId) {
    const { data: flag, error: flagErr } = await supabase
      .from('flags')
      .select(
        `
        id,
        property_id,
        company_id,
        flag_category:flag_categories ( key )
        `,
      )
      .eq('id', flagId)
      .is('deleted_at', null)
      .maybeSingle<{
        id: string
        property_id: string
        company_id: string
        flag_category: { key: string } | { key: string }[] | null
      }>()

    if (flagErr) {
      console.error('[photos/sign] flag read error:', flagErr)
      return { ok: false, error: flagErr.message }
    }
    if (!flag) {
      return { ok: false, error: 'Flag not found.' }
    }
    if (flag.property_id !== propertyId) {
      return { ok: false, error: 'Flag does not belong to this property.' }
    }

    const cat = Array.isArray(flag.flag_category)
      ? flag.flag_category[0]
      : flag.flag_category
    retentionClass = retentionClassForFlagCategory(cat?.key ?? null)
  }

  // Pre-arrival capture: the caller must supply a packId that
  // refers to a draft pack on this property. Submitted packs
  // cannot accept new photos.
  if (!flagId && evidencePackId) {
    const { data: pack, error: packErr } = await supabase
      .from('evidence_packs')
      .select('id, property_id, status')
      .eq('id', evidencePackId)
      .is('deleted_at', null)
      .maybeSingle<{ id: string; property_id: string; status: string }>()
    if (packErr) {
      console.error('[photos/sign] pack read error:', packErr)
      return { ok: false, error: packErr.message }
    }
    if (!pack) {
      return { ok: false, error: 'Evidence pack not found.' }
    }
    if (pack.property_id !== propertyId) {
      return { ok: false, error: 'Pack does not belong to this property.' }
    }
    if (pack.status !== 'draft') {
      return {
        ok: false,
        error:
          'This pack is already submitted. Start a new pre-arrival pack to add more photos.',
      }
    }
  }

  const photoId = randomUUID()
  const storageCtx: StorageContext = flagId
    ? {
        kind: 'flag',
        companyId: property.company_id,
        flagId,
        photoId,
      }
    : {
        kind: 'property',
        companyId: property.company_id,
        propertyId,
        photoId,
      }

  const masterPath = masterStoragePath(storageCtx)
  const thumbPath = thumbStoragePath(storageCtx)

  // createSignedUploadUrl returns a one-shot upload URL valid for
  // 2 hours by default. Even if the URL leaks, it cannot be used
  // to read anything (write-only) and the underlying RLS still
  // requires the request session to belong to a company member.
  const [{ data: masterUpload, error: masterErr }, { data: thumbUpload, error: thumbErr }] =
    await Promise.all([
      supabase.storage.from(EVIDENCE_BUCKET).createSignedUploadUrl(masterPath),
      supabase.storage.from(EVIDENCE_BUCKET).createSignedUploadUrl(thumbPath),
    ])

  if (masterErr || !masterUpload) {
    console.error('[photos/sign] master signed url error:', masterErr)
    return {
      ok: false,
      error: masterErr?.message ?? 'Could not get upload slot (master).',
    }
  }
  if (thumbErr || !thumbUpload) {
    console.error('[photos/sign] thumb signed url error:', thumbErr)
    return {
      ok: false,
      error: thumbErr?.message ?? 'Could not get upload slot (thumb).',
    }
  }

  return {
    ok: true,
    photoId,
    masterPath,
    thumbPath,
    masterUpload: { signedUrl: masterUpload.signedUrl, token: masterUpload.token },
    thumbUpload: { signedUrl: thumbUpload.signedUrl, token: thumbUpload.token },
    retentionClass,
    companyId: property.company_id,
    evidencePackId: flagId ? null : evidencePackId,
  }
}

// ----------------------------------------------------------------
// attachEvidencePhoto — phase 2 of upload
// ----------------------------------------------------------------
//
// Called by the client AFTER both master + thumb have been PUT to
// Storage. Inserts the row into public.photos and writes an audit
// event. The cross-tenant integrity trigger
// (photos_check_company) enforces that company_id matches the
// linked flag/property at the DB layer regardless of what the
// client claims.

export type AttachPhotoInput = {
  photoId: string
  propertyId: string
  flagId?: string | null
  evidencePackId?: string | null
  masterPath: string
  thumbPath: string
  width: number
  height: number
  sizeBytes: number
  capturedAt?: string | null
  note?: string | null
  retentionClass: RetentionClass
}

export async function attachEvidencePhoto(
  input: AttachPhotoInput,
): Promise<{ ok: true; photoId: string } | { ok: false; error: string }> {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'Not authenticated.' }
  }

  const photoId = String(input.photoId ?? '').trim()
  const propertyId = String(input.propertyId ?? '').trim()
  const flagId = input.flagId ? String(input.flagId).trim() : null
  const evidencePackId = input.evidencePackId
    ? String(input.evidencePackId).trim()
    : null

  if (!photoId || !propertyId) {
    return { ok: false, error: 'Missing photo reference.' }
  }

  const note = input.note ? String(input.note).trim().slice(0, 2000) : null
  const supabase = await createClient()

  const { error: insertErr } = await supabase.from('photos').insert({
    id: photoId,
    company_id: ctx.company.id,
    property_id: propertyId,
    flag_id: flagId,
    evidence_pack_id: evidencePackId,
    entity_type: flagId ? 'flag' : 'property',
    retention_class: input.retentionClass,
    uploaded_by: ctx.user.id,
    captured_at: input.capturedAt ?? null,
    storage_path: input.masterPath,
    thumbnail_path: input.thumbPath,
    mime_type: 'image/jpeg',
    width: input.width,
    height: input.height,
    size_bytes: input.sizeBytes,
    notes: note,
    sync_status: 'synced',
  })

  if (insertErr) {
    console.error('[photos/attach] insert error:', insertErr)
    return { ok: false, error: insertErr.message }
  }

  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: ctx.company.id,
    actor_id: ctx.user.id,
    event_kind: 'photo_upload',
    entity_type: 'photo',
    entity_id: photoId,
    metadata: {
      flag_id: flagId,
      property_id: propertyId,
      evidence_pack_id: evidencePackId,
      retention_class: input.retentionClass,
      master_path: input.masterPath,
    },
  })
  if (auditErr) {
    // Audit failure must not break the upload. Log and continue.
    console.error('[photos/attach] audit write failed:', auditErr)
  }

  // Cache invalidation: detail page + Action Centre both render
  // photo counts and grids.
  revalidatePath(`/properties/${propertyId}`)
  if (flagId) {
    revalidatePath(`/properties/${propertyId}/flags/${flagId}`)
    revalidatePath(`/properties/${propertyId}/flags/${flagId}/report`)
  }
  if (evidencePackId) {
    revalidatePath(`/properties/${propertyId}/packs/${evidencePackId}/report`)
  }

  return { ok: true, photoId }
}

// ----------------------------------------------------------------
// updatePhotoNote — edit a photo caption
// ----------------------------------------------------------------
//
// Standard form-action shape: receives FormData, redirects with
// flash on success. Used from the photo grid on the flag detail
// page (per-photo "edit note" inline form).

export async function updatePhotoNote(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const photoId = String(formData.get('photo_id') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()

  if (!propertyId || !photoId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing photo reference.')}`)
  }

  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)
  const detailUrl = flagId
    ? `/properties/${propertyId}/flags/${flagId}`
    : `/properties/${propertyId}`

  if (note.length > 2000) {
    const url = returnTo ?? detailUrl
    redirect(`${url}?error=${encodeURIComponent('Note is too long (max 2000).')}`)
  }

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()

  const { error } = await supabase
    .from('photos')
    .update({ notes: note.length > 0 ? note : null })
    .eq('id', photoId)
    .is('deleted_at', null)

  if (error) {
    console.error('[photos/note] update error:', error)
    const url = returnTo ?? detailUrl
    redirect(`${url}?error=${encodeURIComponent(error.message)}`)
  }

  if (returnTo) redirect(returnTo)
  redirect(`${detailUrl}?photo_updated=1`)
}

// ----------------------------------------------------------------
// softDeleteEvidencePhoto — soft-delete from the grid
// ----------------------------------------------------------------
//
// Sets deleted_at = now() and writes a photo_delete audit event.
// Storage bytes are NOT removed in v1.0 (orphan cleanup ships
// later — see migration header note). The photo disappears from
// every UI grid that filters on deleted_at IS NULL.

export async function softDeleteEvidencePhoto(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const photoId = String(formData.get('photo_id') ?? '').trim()

  if (!propertyId || !photoId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing photo reference.')}`)
  }

  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)
  const detailUrl = flagId
    ? `/properties/${propertyId}/flags/${flagId}`
    : `/properties/${propertyId}`

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) redirect('/login')

  const supabase = await createClient()

  const { error: deleteErr } = await supabase
    .from('photos')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', photoId)
    .is('deleted_at', null)

  if (deleteErr) {
    console.error('[photos/delete] update error:', deleteErr)
    const url = returnTo ?? detailUrl
    redirect(`${url}?error=${encodeURIComponent(deleteErr.message)}`)
  }

  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: ctx.company.id,
    actor_id: ctx.user.id,
    event_kind: 'photo_delete',
    entity_type: 'photo',
    entity_id: photoId,
    metadata: { property_id: propertyId, flag_id: flagId || null },
  })
  if (auditErr) {
    console.error('[photos/delete] audit write failed:', auditErr)
  }

  if (returnTo) redirect(returnTo)
  redirect(`${detailUrl}?photo_deleted=1`)
}
