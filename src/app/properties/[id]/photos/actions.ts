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
  deriveRetentionClass,
  type RetentionClass,
} from '@/lib/photos/retention'
import { isUuid } from '@/lib/photos/finalize-helpers'
import { photoIdentityMatches } from '@/lib/photos/attach-idempotency'
import { checkFlagPhotoCollision } from '@/lib/photos/collision-check'
import { maybeReArmAttachEvidence } from '@/lib/integrations/outbox'
import {
  buildFlagPhotoSlot,
  type FlagPhotoSlotResult,
} from '@/lib/photos/flag-upload-plan'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

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
        chargeable_party_decision,
        flag_category:flag_categories ( key )
        `,
      )
      .eq('id', flagId)
      .is('deleted_at', null)
      .maybeSingle<{
        id: string
        property_id: string
        company_id: string
        chargeable_party_decision: string | null
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
    // Session 9A Slice 1: retention derives from category + accountability.
    retentionClass = deriveRetentionClass({
      categoryKey: cat?.key ?? null,
      accountability: flag.chargeable_party_decision,
    })
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
// requestFlagPhotoUploadSlot — new-flag capture (Slice 11B-1)
// ----------------------------------------------------------------
//
// Dedicated signing endpoint for the field-team new-flag flow, where the
// flag does NOT exist yet and the client generates the flag + photo ids.
// Kept separate from requestPhotoUploadSlot because the return shape
// differs (create-only, per-object, and an already_uploaded state).
//
// Evidence-integrity guarantees:
//   * CREATE-ONLY signed URLs (no upsert). A signed URL outlives its
//     issuance, so an upsert URL could overwrite evidence finalised in the
//     meantime. Create-only means a stale URL fails the moment its target
//     object exists — finalised evidence is never overwritable.
//   * Collision guard (service-role, RLS-bypassing) rejects any existing
//     flag/photo row, including soft-deleted or cross-company.
//   * Per-object existence check → partial retries only re-sign the object
//     still missing; when both exist we return already_uploaded with NO
//     overwrite URLs. To replace a pre-finalisation photo, delete it first
//     via removeFlagPhotoObjects, then request fresh URLs.
//   * Storage paths are derived server-side; never accepted from the caller.

export async function requestFlagPhotoUploadSlot(input: {
  propertyId: string
  proposedFlagId: string
  photoId: string
}): Promise<FlagPhotoSlotResult> {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'Not authenticated.' }
  }

  const propertyId = String(input.propertyId ?? '').trim()
  const proposedFlagId = String(input.proposedFlagId ?? '').trim()
  const photoId = String(input.photoId ?? '').trim()

  if (!propertyId) {
    return { ok: false, error: 'Missing property reference.' }
  }
  if (!isUuid(proposedFlagId) || !isUuid(photoId)) {
    return { ok: false, error: 'Invalid flag or photo id.' }
  }

  const supabase = await createClient()

  // Verify the property belongs to the caller's company (RLS-scoped).
  const { data: property, error: propertyErr } = await supabase
    .from('properties')
    .select('id, company_id')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string }>()
  if (propertyErr) {
    console.error('[photos/sign-flag] property read error:', propertyErr)
    return { ok: false, error: propertyErr.message }
  }
  if (!property) {
    return { ok: false, error: 'Property not found.' }
  }
  if (property.company_id !== ctx.company.id) {
    return { ok: false, error: 'Property is not in your company.' }
  }

  // Collision guard (service-role) — reject any existing flag/photo row,
  // including soft-deleted / cross-company. Runs only after auth + company
  // + property-ownership above. Never writes.
  //
  // createServiceClient() throws if SUPABASE_SERVICE_ROLE_KEY is not present
  // in the deployment env (e.g. a preview deployment where the key is scoped
  // to production only). Without this guard that throw becomes an OPAQUE
  // server-action error the client can only show as "Failed". Catch it and
  // return a clear, safe message instead (no secret/env detail leaked).
  let collision: Awaited<ReturnType<typeof checkFlagPhotoCollision>>
  try {
    const admin = createServiceClient()
    collision = await checkFlagPhotoCollision(admin, { proposedFlagId, photoId })
  } catch (err) {
    console.error('[photos/sign-flag] collision guard unavailable:', err)
    return {
      ok: false,
      error: 'Could not start the photo upload (server configuration error).',
    }
  }
  if (!collision.ok) {
    return { ok: false, error: collision.error }
  }

  // Paths derived server-side (never from the caller).
  const storageCtx: StorageContext = {
    kind: 'flag',
    companyId: property.company_id,
    flagId: proposedFlagId,
    photoId,
  }
  const masterPath = masterStoragePath(storageCtx)
  const thumbPath = thumbStoragePath(storageCtx)

  // Exact object-existence check for partial-retry planning.
  const prefix = `companies/${property.company_id}/flags/${proposedFlagId}`
  const { data: objects, error: listErr } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .list(prefix, { limit: 100 })
  if (listErr) {
    console.error('[photos/sign-flag] storage list error:', listErr)
    return { ok: false, error: `Could not check existing uploads: ${listErr.message}` }
  }
  const present = new Set((objects ?? []).map((o) => o.name))
  const masterExists = present.has(`${photoId}.jpg`)
  const thumbExists = present.has(`${photoId}_thumb.jpg`)

  // Create-only signer — NO upsert. (The CreateOnlySigner type has no
  // upsert parameter, so overwrite cannot be requested here.)
  const sign = async (path: string) => {
    const { data, error } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUploadUrl(path)
    if (error || !data) {
      console.error('[photos/sign-flag] create-only sign error:', error)
      return null
    }
    return { signedUrl: data.signedUrl, token: data.token }
  }

  return buildFlagPhotoSlot(
    {
      photoId,
      companyId: property.company_id,
      masterPath,
      thumbPath,
      masterExists,
      thumbExists,
    },
    sign,
  )
}

// ----------------------------------------------------------------
// removeFlagPhotoObjects — pre-finalisation cleanup (Slice 11B)
// ----------------------------------------------------------------
//
// When a field inspector removes a photo from the uploader BEFORE
// submitting the flag, its bytes are already in Storage but no
// photos row exists yet. We delete the orphaned master + thumb so
// they don't linger.
//
// Decision A (11B-1): there is deliberately NO broad company-scoped
// storage.objects DELETE policy (migration 0012 header). Deletion
// runs through a service-role client instead — but tightly fenced:
//   * caller must be authenticated;
//   * company is resolved server-side from the property (not trusted
//     from the client);
//   * we accept ONLY { propertyId, proposedFlagId, photoId } and
//     validate every id;
//   * paths are DERIVED server-side under the caller's company —
//     an arbitrary Storage path can never be passed in;
//   * removal is allowed ONLY before finalisation: if the flag row
//     or a matching photos row already exists, we refuse (finalised
//     evidence is immutable / soft-delete only).
// The service-role key stays server-only (createServiceClient begins
// with `import 'server-only'`).
//
// If deletion cannot complete cleanly the bytes are left as orphans
// (see the orphan-cleanup note at the foot of this file); we never
// block the user's flow on a best-effort cleanup.

export async function removeFlagPhotoObjects(input: {
  propertyId: string
  proposedFlagId: string
  photoId: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return { ok: false, error: 'Not authenticated.' }
  }

  const propertyId = String(input.propertyId ?? '').trim()
  const proposedFlagId = String(input.proposedFlagId ?? '').trim()
  const photoId = String(input.photoId ?? '').trim()

  if (!propertyId || !isUuid(proposedFlagId) || !isUuid(photoId)) {
    return { ok: false, error: 'Invalid id.' }
  }

  const supabase = await createClient()

  // Company resolved server-side from the property (RLS-scoped read).
  const { data: property, error: propertyErr } = await supabase
    .from('properties')
    .select('id, company_id')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string }>()
  if (propertyErr) {
    console.error('[photos/remove] property read error:', propertyErr)
    return { ok: false, error: propertyErr.message }
  }
  if (!property || property.company_id !== ctx.company.id) {
    return { ok: false, error: 'Property is not in your company.' }
  }

  // Refuse once finalised: either the flag exists, or a photos row
  // for this id already exists. (RLS scopes both reads to the
  // caller's company.)
  const [{ data: existingFlag }, { data: existingPhoto }] = await Promise.all([
    supabase.from('flags').select('id').eq('id', proposedFlagId).maybeSingle(),
    supabase.from('photos').select('id').eq('id', photoId).maybeSingle(),
  ])
  if (existingFlag) {
    return { ok: false, error: 'This flag is already finalised.' }
  }
  if (existingPhoto) {
    return { ok: false, error: 'This photo is already recorded.' }
  }

  // Paths derived server-side under the caller's own company —
  // never a client-supplied path, so we can only ever target the
  // caller's own company prefix.
  const master = masterStoragePath({
    kind: 'flag',
    companyId: ctx.company.id,
    flagId: proposedFlagId,
    photoId,
  })
  const thumb = thumbStoragePath({
    kind: 'flag',
    companyId: ctx.company.id,
    flagId: proposedFlagId,
    photoId,
  })

  const admin = createServiceClient()
  const { error } = await admin.storage.from(EVIDENCE_BUCKET).remove([master, thumb])
  if (error) {
    console.error('[photos/remove] storage remove error:', error)
    return { ok: false, error: error.message }
  }

  return { ok: true }
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
    // Idempotent retry (req 9): a lost response can leave a photo that
    // actually attached looking like a failure. Because the client reuses
    // the SAME server-issued photo id on retry, a primary-key conflict
    // (23505) MAY mean "already attached". Treat it as success ONLY after
    // reading the existing row and confirming it is the exact same logical
    // photo (company, property, pack/flag, storage paths, not deleted). Any
    // mismatch — or an unreadable row (e.g. another company, hidden by RLS)
    // — FAILS CLOSED.
    if (insertErr.code === '23505') {
      const { data: existing } = await supabase
        .from('photos')
        .select(
          'company_id, property_id, flag_id, evidence_pack_id, storage_path, thumbnail_path, deleted_at',
        )
        .eq('id', photoId)
        .maybeSingle<{
          company_id: string
          property_id: string
          flag_id: string | null
          evidence_pack_id: string | null
          storage_path: string
          thumbnail_path: string
          deleted_at: string | null
        }>()

      if (
        existing &&
        photoIdentityMatches(
          {
            companyId: existing.company_id,
            propertyId: existing.property_id,
            flagId: existing.flag_id,
            evidencePackId: existing.evidence_pack_id,
            storagePath: existing.storage_path,
            thumbnailPath: existing.thumbnail_path,
            deletedAt: existing.deleted_at,
          },
          {
            companyId: ctx.company.id,
            propertyId,
            flagId,
            evidencePackId,
            storagePath: input.masterPath,
            thumbnailPath: input.thumbPath,
          },
        )
      ) {
        return { ok: true, photoId }
      }

      console.error('[photos/attach] 23505 with non-matching / unreadable row:', photoId)
      return {
        ok: false,
        error: 'This photo could not be saved (id conflict). Retry the capture.',
      }
    }
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

  // Slice 11C2: a follow-up photo on an existing flag changes the report
  // content → re-arm the Asana evidence attach (attach-only, failure-isolated)
  // so the new photo + new PDF revision get attached. Pack photos don't apply.
  if (flagId) {
    await maybeReArmAttachEvidence(supabase, {
      companyId: ctx.company.id,
      flagId,
      createdBy: ctx.user.id,
    })
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

  // Revalidate the property dashboard + (if applicable) the flag
  // detail/report so the new caption shows up immediately. The
  // pack report is the most common return target for pre-arrival
  // caption edits; revalidatePath with no specific id covers all
  // packs because the report route uses dynamic segments.
  revalidatePath(`/properties/${propertyId}`)
  if (flagId) {
    revalidatePath(`/properties/${propertyId}/flags/${flagId}`)
    revalidatePath(`/properties/${propertyId}/flags/${flagId}/report`)
  }
  // Pack report paths share the same dynamic ancestor; revalidating
  // the layout cascade is the broadest safe option.
  revalidatePath(`/properties/${propertyId}/packs`, 'layout')

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

  // Same revalidation pattern as updatePhotoNote — covers
  // dashboard, flag detail/report, and pack report routes.
  revalidatePath(`/properties/${propertyId}`)
  if (flagId) {
    revalidatePath(`/properties/${propertyId}/flags/${flagId}`)
    revalidatePath(`/properties/${propertyId}/flags/${flagId}/report`)
  }
  revalidatePath(`/properties/${propertyId}/packs`, 'layout')

  if (returnTo) redirect(returnTo)
  redirect(`${detailUrl}?photo_deleted=1`)
}

// ----------------------------------------------------------------
// Orphan-cleanup rule (documented; no cleanup worker this slice)
// ----------------------------------------------------------------
//
// Two ways bytes can end up in Storage with no matching photos row:
//   1. A new-flag capture uploads master/thumb, then the inspector
//      abandons the flag without submitting (removeFlagPhotoObjects
//      is best-effort — a failed remove leaves the bytes behind).
//   2. A submitted photo is later soft-deleted (deleted_at set); its
//      bytes are intentionally retained today (see migration 0012).
//
// A FUTURE service-role cleanup job (NOT part of 11B) may safely purge
// objects under companies/{companyId}/flags/{flagId}/ when:
//   * there is NO non-deleted photos row whose storage_path /
//     thumbnail_path matches the object, AND
//   * the object is older than a safety window (e.g. 7 days) so an
//     in-flight upload is never deleted mid-capture.
// Retention-classed, finalised photos are out of scope for any such
// job — only genuine orphans are eligible. No worker is required for
// the beta; orphan storage cost is negligible next to retained
// evidence.
