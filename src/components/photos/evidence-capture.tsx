'use client'

/**
 * EvidenceCapture — the mobile-first multi-photo capture surface.
 *
 * Two capture sources, same review/attach pipeline:
 *
 *   1. In-browser shutter loop. Opens the device camera via
 *      getUserMedia({ video: { facingMode: 'environment' } }) and
 *      renders a live preview. The shutter tap grabs a canvas
 *      frame from the video element. The camera STAYS OPEN across
 *      shots — this is the make-or-break workflow for on-site use.
 *      Works on iOS Safari 16.4+ (requires HTTPS) and on Android
 *      Chrome.
 *
 *   2. Gallery / file input fallback. <input type="file"
 *      accept="image/*" multiple>. Allows multi-select where the
 *      browser supports it. Used when the user denied camera
 *      permission, when they want to attach photos taken in the
 *      native Camera app, or as a robustness fallback if
 *      getUserMedia errors out.
 *
 * Both sources land in the same in-memory `pending[]` array, get
 * compressed locally (canvas, JPEG ~80%), and on "Attach" upload
 * one-by-one via the requestPhotoUploadSlot + attachEvidencePhoto
 * pair. Notes are optional and per-photo; the user can also tap
 * "Note for all" to set the same caption on every photo in the
 * batch.
 *
 * Deliberate v1.0 constraints (deferred):
 *   - No IndexedDB queue. If the user closes the tab mid-batch,
 *     in-memory photos are lost. The compressed-master files are
 *     never persisted client-side outside RAM.
 *   - No background sync. Uploads run while this modal is open
 *     and the user is online.
 *   - No collage. Multiple photos of one item are stored as
 *     individual rows; the report layer renders them as a grid.
 *
 * Cleanup discipline:
 *   - Object URLs for thumb previews are revoked when a pending
 *     photo is removed and when the modal closes (Effect cleanup).
 *   - getUserMedia stream tracks are stopped on every camera-close
 *     path (close button, gallery fallback, modal close).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  Camera,
  Flag,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { compressForEvidence } from '@/lib/photos/compress'
import { packCapture } from '@/lib/photos/pack-capture-store'
import { PhotoQueueUnavailableError } from '@/lib/photos/photo-queue-db'
import { drainQueue, enqueuePhoto, releaseQueued } from '@/lib/photos/photo-queue'
import { packScopeError } from '@/lib/photos/photo-queue-state'
import {
  attachEvidencePhoto,
  requestPhotoUploadSlot,
  type UploadSlot,
} from '@/app/properties/[id]/photos/actions'

type Pending = {
  /** Client-side id for keying React + UI state. Not the DB photo id. */
  id: string
  /** Raw source blob (uncompressed) — we only keep it until compression. */
  rawBlob: Blob
  /** Compressed master JPEG (set after compression). */
  master?: Blob
  /** Compressed thumb JPEG (set after compression). */
  thumb?: Blob
  /** Object URL for the in-strip preview. */
  previewUrl: string
  /** Pixel width of the master. */
  width?: number
  /** Pixel height of the master. */
  height?: number
  /** Optional caption — user-edited per-photo. */
  note: string
  /** Capture time (best-effort: file.lastModified for gallery, Date.now for shutter). */
  capturedAt: string
  /** Pipeline state — drives UI affordances. */
  state: 'compressing' | 'ready' | 'uploading' | 'uploaded' | 'error'
  /** Last error message, if any. */
  error?: string
  /** Upload slot issued for THIS logical photo, reused across retries so a
   *  lost-response retry targets the same id/paths (idempotent). */
  slot?: UploadSlot
  /** Whether the master / thumb object has already been PUT to Storage
   *  (so a retry skips re-uploading what already landed). */
  masterDone?: boolean
  thumbDone?: boolean
}

type Props = {
  propertyId: string
  /** Optional — when present, captures attach to this flag. */
  flagId?: string | null
  /**
   * Optional — when present (and flagId is not), captures attach
   * to this draft evidence pack. The server validates the pack is
   * a draft on this property before signing.
   */
  evidencePackId?: string | null
  /** Label customisation for the launch button. */
  launchLabel?: string
  /** Variant for the launch button. */
  launchVariant?: 'primary' | 'subtle'
  /**
   * Optional URL to send the user to if they want to raise a flag
   * from the review screen. Rendered as a tertiary action. The
   * pack/flag context this capture session is in is the natural
   * "return path" the user lands on once they're back.
   *
   * Note: as of the Session 8 pre-merge revision, the raise-flag
   * UX is handled internally (the component navigates after
   * attaching pending photos) — this prop's presence still gates
   * whether the affordance shows, but the target URL is computed
   * from propertyId + flag/new.
   */
  raiseFlagHref?: string | null
  /**
   * When true, the modal opens automatically on mount. Used by the
   * Action Centre after the user clicks "Start pre-arrival pack" —
   * the server action redirects with capture_now=1 so the camera
   * surface comes up immediately, no second tap required.
   */
  autoOpen?: boolean
  /**
   * When true, the modal skips getUserMedia entirely and opens the
   * native file picker on mount. After files are chosen the user
   * lands in the review screen as usual. This is the bulletproof
   * fallback for phones / browsers where in-app camera access is
   * blocked (insecure context, denied permission, browser bug).
   */
  startInGalleryMode?: boolean
  /**
   * Outcome 3: required for PRE-ARRIVAL PACK capture so each photo can be
   * written to the app-private durable queue, scoped to this user/company.
   * Omitted for flag capture, which keeps its original in-memory pipeline.
   */
  userId?: string
  companyId?: string
}

/**
 * Client-side LOGICAL PHOTO ID. Must be a real v4 UUID: it is reused across
 * retries and becomes the primary key of the durable server-side upload
 * intent (and then of public.photos). getRandomValues works on plain http
 * too, so LAN testing keeps a valid uuid.
 */
function makeClientId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function EvidenceCapture({
  propertyId,
  flagId,
  evidencePackId,
  launchLabel,
  launchVariant = 'primary',
  raiseFlagHref,
  autoOpen = false,
  startInGalleryMode = false,
  userId,
  companyId,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [attachAllNote, setAttachAllNote] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [stage, setStage] = useState<'shooting' | 'reviewing' | 'uploading' | 'done'>(
    'shooting',
  )
  const [batchError, setBatchError] = useState<string | null>(null)
  /** Pack mode: how many photos were handed to the durable background worker. */
  const [handedOffCount, setHandedOffCount] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  /** Guards the one-shot capture_now auto-open for the life of this mount. */
  const autoOpenConsumedRef = useRef(false)
  const galleryInputRef = useRef<HTMLInputElement | null>(null)

  // --------------------------------------------------------------
  // Camera lifecycle
  // --------------------------------------------------------------

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setCameraReady(false)
  }, [])

  const startCamera = useCallback(async () => {
    setCameraError(null)
    setCameraReady(false)
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        'This browser does not support in-app camera capture. Use "From gallery" instead.',
      )
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Required by iOS Safari to keep the preview inline instead
        // of going fullscreen.
        videoRef.current.setAttribute('playsinline', 'true')
        await videoRef.current.play().catch(() => {
          /* play() can reject on autoplay restrictions; user tap will retry */
        })
      }
      setCameraReady(true)
    } catch (err) {
      // Common shapes: NotAllowedError (permission denied),
      // NotFoundError (no camera), SecurityError (insecure context).
      // We don't surface the technical name — operators just see
      // a clear human message + a one-tap fallback path.
      const name = err instanceof Error ? err.name : ''
      const msg =
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Use "From gallery" instead, or grant camera access in your browser settings.'
          : name === 'NotFoundError'
            ? 'No camera was detected on this device. Use "From gallery" to attach photos.'
            : name === 'SecurityError'
              ? 'Camera blocked by the browser. Make sure this app is on HTTPS, then retry — or use "From gallery".'
              : 'Could not access the camera. Use "From gallery" to attach photos.'
      setCameraError(msg)
    }
  }, [])

  // Start camera when modal opens (and we're in shooting stage).
  // Stop it on close / on unmount.
  //
  // Skip getUserMedia entirely when startInGalleryMode is true —
  // we want the gallery picker as the only entry point so phones
  // / browsers that block in-app camera can't get stuck.
  //
  // The React 19 react-hooks/set-state-in-effect rule fires because
  // startCamera() synchronously calls setCameraError(null) +
  // setCameraReady(false) before awaiting getUserMedia. That's
  // exactly what we want — reset the visible state before kicking
  // off the async permission flow. Deferring via queueMicrotask
  // would only hide the same calls from the linter without changing
  // behaviour.
  useEffect(() => {
    if (open && stage === 'shooting' && !startInGalleryMode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void startCamera()
    } else {
      stopCamera()
    }
    return () => {
      stopCamera()
    }
  }, [open, stage, startCamera, stopCamera, startInGalleryMode])

  // NOTE: We intentionally do NOT auto-click the file input on
  // mount. iOS Safari (and increasingly other mobile browsers)
  // require file-picker opens to come from a direct user gesture.
  // A programmatic .click() from useEffect is blocked silently.
  // The gallery-only shooting screen renders a "Choose photos"
  // button — that tap IS the user gesture and triggers the picker.

  // Revoke object URLs when pending items change or modal closes.
  useEffect(() => {
    return () => {
      for (const p of pending) URL.revokeObjectURL(p.previewUrl)
    }
    // Intentionally not depending on `pending`; cleanup runs on unmount only.
    // Per-item revoke happens inside removePending().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lock background page scroll while the full-screen modal is
  // open. Without this, the page behind the portal can still
  // scroll/drift on touch — which on iOS reads as "the page
  // moves under the camera". Restores the previous overflow on
  // close so we don't clobber another modal's lock.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // --------------------------------------------------------------
  // Capture helpers
  // --------------------------------------------------------------

  const ingestBlob = useCallback(async (rawBlob: Blob, capturedAt: string) => {
    const id = makeClientId()
    const previewUrl = URL.createObjectURL(rawBlob)
    const item: Pending = {
      id,
      rawBlob,
      previewUrl,
      note: '',
      capturedAt,
      state: 'compressing',
    }
    setPending((prev) => [...prev, item])

    try {
      const compressed = await compressForEvidence(rawBlob)

      // DURABILITY GATE (Outcome 3): for a pre-arrival pack, both blobs are
      // written to app-private IndexedDB BEFORE this photo is shown as
      // captured and BEFORE any network call. An Android phone call can
      // evict this page at any moment; if the bytes are not on disk first,
      // they are gone. If the device cannot store them we must NOT pretend
      // the photo is safe. (Flag capture is unchanged — no queue.)
      if (evidencePackId) {
        // Runtime assertion: pack capture must NEVER fall back to a
        // memory-only path because a scope value is missing.
        const scopeError = packScopeError({
          userId,
          companyId,
          propertyId,
          packId: evidencePackId,
        })
        if (scopeError) throw new PhotoQueueUnavailableError(scopeError)

        await enqueuePhoto(
          { userId: userId!, companyId: companyId!, propertyId, packId: evidencePackId },
          {
            id,
            master: compressed.master,
            thumb: compressed.thumb,
            width: compressed.width,
            height: compressed.height,
            sizeBytes: compressed.master.size,
            capturedAt,
            note: null,
            release: false, // the inspector may still add a note
          },
        )
      }

      // Replace preview with the smaller thumb (lower memory).
      URL.revokeObjectURL(previewUrl)
      const thumbUrl = URL.createObjectURL(compressed.thumb)
      setPending((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                master: compressed.master,
                thumb: compressed.thumb,
                previewUrl: thumbUrl,
                width: compressed.width,
                height: compressed.height,
                state: 'ready',
              }
            : p,
        ),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to process image.'
      // A storage failure is NOT a "captured" photo. Surface it loudly and
      // drop the item rather than leaving a false sense of safety.
      setPending((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, state: 'error', error: msg } : p,
        ),
      )
      if (err instanceof PhotoQueueUnavailableError) {
        setBatchError(
          'This photo could NOT be saved on your device, so it is not safe yet. ' +
            'Free up space or use a different browser, then take it again. ' +
            'Do not submit this pack until every photo is saved.',
        )
      }
    }
  }, [evidencePackId, userId, companyId, propertyId])

  const handleShutter = useCallback(async () => {
    if (!videoRef.current || !cameraReady) return
    const video = videoRef.current
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
    )
    if (!blob) return
    void ingestBlob(blob, new Date().toISOString())
  }, [cameraReady, ingestBlob])

  const handleGallery = useCallback(
    async (files: FileList | null) => {
      if (!files) return
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        const capturedAt = file.lastModified
          ? new Date(file.lastModified).toISOString()
          : new Date().toISOString()
        await ingestBlob(file, capturedAt)
      }
    },
    [ingestBlob],
  )

  const removePending = useCallback(
    (id: string) => {
      // Release the logical photo from the pack intent map (no-op if it was
      // never committed). Does not lower the persisted target.
      if (evidencePackId) packCapture.remove(evidencePackId, id)
      setPending((prev) => {
        const next: Pending[] = []
        for (const p of prev) {
          if (p.id === id) {
            URL.revokeObjectURL(p.previewUrl)
          } else {
            next.push(p)
          }
        }
        return next
      })
    },
    [evidencePackId],
  )

  // --------------------------------------------------------------
  // Modal open/close
  // --------------------------------------------------------------

  const openModal = useCallback(() => {
    setOpen(true)
    setStage('shooting')
    setBatchError(null)
  }, [])

  // Pre-arrival pack capture sessions require a packId — fail
  // closed if a caller forgets it. Flag captures don't need a pack.
  // Declared here (not at the render block) because the auto-open
  // effect below reads it; both inputs are props, so this is safe.
  const isMisconfigured = !flagId && !evidencePackId

  // Auto-open on mount when the parent passes autoOpen=true. Used
  // by the Action Centre after Start pre-arrival pack — server
  // redirects with capture_now=1, the Action Centre threads that
  // here, and the camera surface comes up without a second tap.
  // Misconfigured callers (no flagId + no packId) are guarded by
  // the disabled launch button check above; we re-check before
  // auto-opening so a stale URL doesn't surface a useless modal.
  useEffect(() => {
    if (autoOpen && !open && !isMisconfigured && !autoOpenConsumedRef.current) {
      // One-shot per mount. The server-supplied autoOpen prop stays true for
      // this render, so without this ref the effect could re-open the camera
      // straight after the inspector closes it. URL cleanup alone is not
      // enough because the prop was already computed.
      autoOpenConsumedRef.current = true
      // capture_now is a ONE-TIME instruction. Strip it from the URL as soon
      // as we act on it, otherwise every refresh re-opens the camera — which
      // is disorienting mid-upload and looks like the app is restarting.
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        if (url.searchParams.has('capture_now')) {
          url.searchParams.delete('capture_now')
          // Preserve Next.js's router state — passing {} would discard it and
          // can break client-side navigation/history.
          window.history.replaceState(window.history.state, '', url.toString())
        }
      }
      openModal()
    }
    // intentionally only react to autoOpen flipping true on mount;
    // we don't want re-renders to surprise-reopen the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen])

  const closeModal = useCallback(() => {
    stopCamera()
    setOpen(false)
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.previewUrl)
      return []
    })
    setAttachAllNote('')
    setStage('shooting')
    setEditingId(null)
    setBatchError(null)
    setHandedOffCount(0)
  }, [stopCamera])

  // Dismiss guard (req 8): closing a session that still holds unattached,
  // uploading or failed photos requires an explicit DESTRUCTIVE confirm and
  // never implies they were saved. On confirm, those logical photos are
  // released from the pack intent map (the persisted target is unchanged, so
  // the pack still requires those photos be recaptured before it can submit).
  const dismiss = useCallback(() => {
    const unresolved = pending.filter((p) => p.state !== 'uploaded')
    if (unresolved.length > 0) {
      const ok =
        typeof window === 'undefined' ||
        window.confirm(
          `${unresolved.length} photo${unresolved.length === 1 ? '' : 's'} ` +
            `${unresolved.length === 1 ? 'has' : 'have'} NOT been saved to the pack and ` +
            `will be discarded. Close anyway?`,
        )
      if (!ok) return
      if (evidencePackId) {
        for (const p of unresolved) packCapture.remove(evidencePackId, p.id)
      }
    }
    closeModal()
  }, [pending, evidencePackId, closeModal])

  // --------------------------------------------------------------
  // Attach pipeline
  // --------------------------------------------------------------
  //
  // uploadOne handles a single photo: sign + parallel PUTs + attach
  // row. Returns true on success, false on failure. Updates per-
  // photo state via setPending so the UI strip stays live.
  //
  // runUploads runs uploadOne with bounded concurrency. UPLOAD_CONCURRENCY=3
  // is the sweet spot for mobile — sequential is too slow for 10+ photo
  // batches, full-parallel saturates the radio and causes timeouts.
  // Returns true if ALL ready photos succeeded.

  const uploadOne = useCallback(
    async (item: Pending): Promise<boolean> => {
      setPending((prev) =>
        prev.map((p) =>
          p.id === item.id ? { ...p, state: 'uploading', error: undefined } : p,
        ),
      )
      if (evidencePackId) packCapture.mark(evidencePackId, item.id, 'uploading')
      try {
        // Reuse a slot already issued for this logical photo on retry, so the
        // SAME photo id + storage paths are targeted. Combined with the
        // idempotent attach (a PK conflict = already attached) and treating a
        // Storage 409 as "already uploaded", a lost-response retry can never
        // create a duplicate row or object.
        let slot = item.slot
        if (!slot) {
          const requested = (await requestPhotoUploadSlot({
            propertyId,
            flagId: flagId ?? null,
            evidencePackId: evidencePackId ?? null,
            // Stable logical id → idempotent intent + slot across retries.
            photoId: item.id,
          })) as UploadSlot | { ok: false; error: string }
          if (!requested.ok) throw new Error(requested.error)
          slot = requested
          const issued = slot
          setPending((prev) =>
            prev.map((p) => (p.id === item.id ? { ...p, slot: issued } : p)),
          )
        }

        // Create-only Storage: a 409 means the object already landed from a
        // prior attempt — idempotent, treat as done. Skip anything already PUT.
        const putOnce = async (signedUrl: string, blob: Blob, already: boolean) => {
          if (already) return
          const res = await fetch(signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
          })
          if (!res.ok && res.status !== 409) {
            throw new Error(`Upload failed (${res.status}).`)
          }
        }
        await putOnce(slot.masterUpload.signedUrl, item.master as Blob, !!item.masterDone)
        setPending((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, masterDone: true } : p)),
        )
        await putOnce(slot.thumbUpload.signedUrl, item.thumb as Blob, !!item.thumbDone)
        setPending((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, thumbDone: true } : p)),
        )

        if (evidencePackId) packCapture.mark(evidencePackId, item.id, 'attaching')
        const finalNote = (item.note?.trim() || attachAllNote.trim() || null) as
          | string
          | null

        const attached = await attachEvidencePhoto({
          photoId: slot.photoId,
          propertyId,
          flagId: flagId ?? null,
          evidencePackId: slot.evidencePackId,
          masterPath: slot.masterPath,
          thumbPath: slot.thumbPath,
          width: item.width ?? 0,
          height: item.height ?? 0,
          sizeBytes: item.master?.size ?? 0,
          capturedAt: item.capturedAt,
          note: finalNote,
          retentionClass: slot.retentionClass,
        })

        if (!attached.ok) throw new Error(attached.error)

        setPending((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, state: 'uploaded' } : p)),
        )
        if (evidencePackId) packCapture.mark(evidencePackId, item.id, 'saved')
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.'
        setPending((prev) =>
          prev.map((p) =>
            p.id === item.id ? { ...p, state: 'error', error: msg } : p,
          ),
        )
        if (evidencePackId) packCapture.mark(evidencePackId, item.id, 'failed')
        return false
      }
    },
    [propertyId, flagId, evidencePackId, attachAllNote],
  )

  const runUploads = useCallback(
    async (items: Pending[]): Promise<boolean> => {
      if (items.length === 0) return true
      // 4 concurrent uploads — bumped from 3 alongside the smaller
      // compressed-file size. Smaller files mean each upload holds
      // the connection for less time, so a slightly higher
      // concurrency drains a big batch faster without saturating a
      // mobile radio.
      const UPLOAD_CONCURRENCY = 4
      const queue = [...items]
      let allOk = true
      const workers = Array.from(
        { length: Math.min(UPLOAD_CONCURRENCY, queue.length) },
        async () => {
          while (true) {
            const next = queue.shift()
            if (!next) return
            const ok = await uploadOne(next)
            if (!ok) allOk = false
          }
        },
      )
      await Promise.all(workers)
      return allOk
    },
    [uploadOne],
  )

  const handleAttach = useCallback(async () => {
    const readyItems = pending.filter((p) => p.state === 'ready' && p.master && p.thumb)
    if (readyItems.length === 0) {
      setBatchError('Nothing to attach yet. Wait for the photos to finish processing.')
      return
    }
    setStage('uploading')
    setBatchError(null)

    // PRE-ARRIVAL PACK: the bytes are already durable in IndexedDB, so we do
    // NOT upload from this component. Release the records to the sequential
    // worker, which survives this modal closing, a reload, or the browser
    // being killed, and which resumes automatically. (Flag capture keeps the
    // original in-memory pipeline below, unchanged.)
    if (evidencePackId) {
      for (const it of readyItems) packCapture.commit(evidencePackId, it.id)
      const notes: Record<string, string | null> = {}
      for (const it of readyItems) {
        notes[it.id] = it.note?.trim() || attachAllNote.trim() || null
      }
      // The modal does NOT upload for packs — it hands the durable records to
      // the background worker. Only count them AFTER the handoff succeeds, so
      // a failure can never render as success. Accumulate across repeated
      // "More photos → Attach" rounds in the same session.
      await releaseQueued(evidencePackId, notes)
      setHandedOffCount((c) => c + readyItems.length)
      void drainQueue(evidencePackId)
      setStage('done')
      return
    }

    await runUploads(readyItems)
    setStage('done')
  }, [pending, runUploads, evidencePackId, attachAllNote])

  // Retry photos whose upload/attach failed, so a failed save is never a
  // silent loss (the compressed blobs are still held in memory here — they
  // are NOT saved to the device, so leaving/reloading would lose them).
  // Each retry requests a FRESH upload slot + photo id, so the failed
  // attempt (which never persisted a row) cannot create a duplicate.
  const retryFailed = useCallback(async () => {
    const failedItems = pending.filter((p) => p.state === 'error' && p.master && p.thumb)
    if (failedItems.length === 0) return
    setStage('uploading')
    setBatchError(null)
    if (evidencePackId) {
      for (const it of failedItems) packCapture.mark(evidencePackId, it.id, 'uploading')
    }
    setPending((prev) =>
      prev.map((p) => (p.state === 'error' ? { ...p, state: 'ready', error: undefined } : p)),
    )
    // Reuses each item's stored slot + PUT progress → idempotent retry.
    await runUploads(failedItems.map((f) => ({ ...f, state: 'ready' as const })))
    setStage('done')
  }, [pending, runUploads, evidencePackId])

  // Raise-flag shortcut: attaches any pending-and-ready photos to
  // the current pack first (so they're not silently lost), then
  // navigates to the flag-creation page. If any upload fails, we
  // stay on the review screen and surface the error — no silent
  // photo loss.
  const handleRaiseFlag = useCallback(async () => {
    const readyItems = pending.filter((p) => p.state === 'ready' && p.master && p.thumb)
    if (readyItems.length > 0) {
      setStage('uploading')
      setBatchError(null)
      // Same intent accounting as handleAttach so the shared store stays
      // balanced when photos are attached via the Report-issue shortcut.
      if (evidencePackId) {
        for (const it of readyItems) packCapture.commit(evidencePackId, it.id)
      }
      const allOk = await runUploads(readyItems)
      if (!allOk) {
        setBatchError(
          'Some photos failed to attach. Retry or remove them, then tap Report issue again.',
        )
        setStage('reviewing')
        return
      }
    }
    // Stop the camera + clear in-memory state before leaving so we
    // don't keep a getUserMedia stream alive across the navigation.
    stopCamera()
    if (typeof window !== 'undefined') {
      const target = `/properties/${propertyId}/flags/new`
      // Diagnostic — if the user reports a 404 after this we can
      // see in dev tools whether the URL was malformed (e.g.
      // propertyId got dropped to undefined).
      console.info('[EvidenceCapture] navigating to raise-flag:', target)
      window.location.href = target
    }
  }, [pending, runUploads, propertyId, stopCamera, evidencePackId])

  const finishAndReload = useCallback(() => {
    closeModal()
    // router.refresh() asks the server for fresh RSC payload
    // without doing a full window.location.reload() — iOS Safari
    // has been observed to serve cached GETs back after a reload,
    // making freshly-uploaded photos invisible. router.refresh()
    // sidesteps that.
    router.refresh()
  }, [closeModal, router])

  // --------------------------------------------------------------
  // Derived UI state
  // --------------------------------------------------------------

  const readyCount = pending.filter((p) => p.state === 'ready').length
  const uploadingCount = pending.filter((p) => p.state === 'uploading').length
  const uploadedCount = pending.filter((p) => p.state === 'uploaded').length
  const errorCount = pending.filter((p) => p.state === 'error').length
  const isMidUpload = stage === 'uploading'

  // Warn before leaving/reloading while there is unsaved photo work
  // (captured/selected/failed but not yet linked). These compressed
  // blobs live only in memory — a reload would lose them silently, which
  // is exactly how evidence went missing. Native beforeunload only; no
  // new deps, and it self-removes once everything is saved.
  const hasUnsavedWork = pending.some(
    (p) => p.state === 'ready' || p.state === 'uploading' || p.state === 'error',
  )
  useEffect(() => {
    if (!hasUnsavedWork) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsavedWork])

  // --------------------------------------------------------------
  // Render
  // --------------------------------------------------------------

  const launchClass =
    launchVariant === 'primary'
      ? 'inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 active:bg-slate-950 disabled:opacity-50 disabled:cursor-not-allowed transition'
      : 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition'

  // Render the modal via createPortal so it lands directly on
  // document.body and isn't scoped by an ancestor's `transform`
  // or `filter`. Without the portal, any ancestor with CSS
  // transform — and Tailwind sprinkles transforms via `hover:`,
  // `animate-`, etc. — would re-root our `position: fixed` modal
  // to that ancestor instead of the viewport. On iOS Safari this
  // shows up as "Take photos does nothing" because the modal
  // renders at 0×0 or off-screen behind the page content.
  const modal = open ? (
    <div
      // Inline style as a belt-and-braces guard alongside the
      // Tailwind utilities — some Tailwind v4 / Turbopack hot-
      // reload combinations have dropped `fixed inset-0` rules in
      // the wild. Forcing the geometry inline makes this immune.
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        // Use inset (top/left/right/bottom: 0) for sizing rather
        // than width:100vw — 100vw includes scrollbar width on
        // some browsers and can itself cause horizontal overflow.
        // top/bottom 0 + 100dvh height handles iOS Safari's
        // dynamic (shrinking) viewport correctly.
        height: '100dvh',
      }}
      className="bg-slate-950/95 text-white flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Evidence capture"
    >
          {/* Top bar.
              The Raise-flag button sits here (not deep in the
              review screen) so an inspector can pivot to recording
              a defect after taking 1 or 40 photos without hunting.
              On tap: pending photos are attached first (so they
              don't silently disappear), THEN we navigate to the
              flag-creation page. */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-slate-950/70 backdrop-blur">
            <p className="text-sm font-medium truncate">
              {stage === 'shooting'
                ? `${pending.length} photo${pending.length === 1 ? '' : 's'}`
                : stage === 'reviewing'
                  ? `Review ${pending.length} photo${pending.length === 1 ? '' : 's'}`
                  : stage === 'uploading'
                    ? `Uploading ${uploadingCount}…  (${uploadedCount}/${pending.length} done)`
                    : evidencePackId
                      ? `${handedOffCount} photo${handedOffCount === 1 ? '' : 's'} saved on this device`
                      : `Attached ${uploadedCount} photo${uploadedCount === 1 ? '' : 's'}`}
            </p>
            <div className="flex items-center gap-2">
              {raiseFlagHref && (stage === 'shooting' || stage === 'reviewing') ? (
                <button
                  type="button"
                  onClick={handleRaiseFlag}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 text-slate-950 px-2.5 py-1.5 text-xs font-semibold hover:bg-amber-300 active:bg-amber-500 transition"
                  title="Attach pending photos to the pack, then open the report-issue workflow"
                >
                  <Flag size={13} aria-hidden />
                  Report issue
                </button>
              ) : null}
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full p-1.5 hover:bg-white/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close camera"
                // Disabled only during an active upload batch (in flight);
                // otherwise closing with unattached/failed photos goes through
                // the destructive confirm in `dismiss` (req 8).
                disabled={isMidUpload}
              >
                <X size={20} aria-hidden />
              </button>
            </div>
          </div>

          {/* Body */}
          {stage === 'shooting' ? (
            <div className="flex-1 flex flex-col">
              {/* Camera preview (skipped entirely when in gallery-only
                  mode — phones with blocked getUserMedia get a clean
                  gallery picker UI instead of a dead-camera screen). */}
              {startInGalleryMode ? (
                <div className="relative flex-1 bg-slate-900 overflow-hidden flex flex-col items-center justify-center px-6 text-center gap-4">
                  <ImageIcon size={36} className="text-white/40" aria-hidden />
                  <div>
                    <p className="text-base font-medium text-white">
                      Upload from gallery
                    </p>
                    <p className="text-sm text-white/60 mt-1 max-w-sm">
                      Choose photos you already took with your phone&rsquo;s
                      Camera app. You can pick multiple at once.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => galleryInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white text-slate-900 px-4 py-2 text-sm font-semibold hover:bg-slate-100 active:bg-slate-200 transition"
                  >
                    <ImageIcon size={14} aria-hidden />
                    Choose photos
                  </button>
                </div>
              ) : (
                <div className="relative flex-1 bg-black overflow-hidden">
                  <video
                    ref={videoRef}
                    className="absolute inset-0 w-full h-full object-cover"
                    muted
                    playsInline
                  />
                  {!cameraReady && !cameraError ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
                      <Loader2 size={20} className="animate-spin mr-2" aria-hidden />
                      Starting camera…
                    </div>
                  ) : null}
                  {cameraError ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center gap-3">
                      <p className="text-sm text-white/85 max-w-sm leading-relaxed">
                        {cameraError}
                      </p>
                      <button
                        type="button"
                        onClick={() => galleryInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-md bg-white text-slate-900 px-4 py-2 text-sm font-semibold hover:bg-slate-100 active:bg-slate-200 transition"
                      >
                        <ImageIcon size={14} aria-hidden />
                        Use gallery instead
                      </button>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Photo strip */}
              {pending.length > 0 ? (
                <div className="px-3 py-2 bg-slate-900/80 border-t border-white/10 overflow-x-auto">
                  <div className="flex items-center gap-2 min-w-max">
                    {pending.map((p) => (
                      <div key={p.id} className="relative shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={p.previewUrl}
                          alt=""
                          className={`h-14 w-14 rounded object-cover border ${p.state === 'error' ? 'border-red-500' : 'border-white/20'}`}
                        />
                        {p.state === 'compressing' ? (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded">
                            <Loader2 size={14} className="animate-spin" aria-hidden />
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-950 border border-white/30 p-0.5 hover:bg-red-600 transition"
                          aria-label="Remove photo"
                        >
                          <X size={10} aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Controls */}
              <div className="px-4 py-4 bg-slate-950 border-t border-white/10 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-xs font-medium text-white/80 hover:bg-white/10 transition"
                >
                  <ImageIcon size={14} aria-hidden />
                  Gallery
                </button>

                {startInGalleryMode ? (
                  // No shutter in gallery-only mode — leave the
                  // space so the bottom bar layout stays balanced
                  // (Gallery / [spacer] / Next).
                  <span className="h-16 w-16" aria-hidden />
                ) : (
                  <button
                    type="button"
                    onClick={handleShutter}
                    disabled={!cameraReady}
                    className="h-16 w-16 rounded-full bg-white text-slate-950 disabled:opacity-40 active:scale-95 transition flex items-center justify-center shadow-xl border-4 border-white/30"
                    aria-label="Take photo"
                  >
                    <span className="block h-12 w-12 rounded-full bg-white border-2 border-slate-950" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setStage('reviewing')}
                  disabled={pending.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-600 transition"
                >
                  Next
                </button>

                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void handleGallery(e.target.files)
                    // Reset so picking the same file again still fires onChange.
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          ) : null}

          {stage === 'reviewing' ? (
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="mb-4">
                <label className="block text-xs font-medium text-white/70 mb-1">
                  Note for all photos (optional — applies if a photo has no specific note)
                </label>
                <textarea
                  value={attachAllNote}
                  onChange={(e) => setAttachAllNote(e.target.value)}
                  placeholder="e.g. Stain on couch — see angles 1–3"
                  rows={2}
                  className="w-full rounded-md bg-slate-900 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <ul className="space-y-3">
                {pending.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-lg border border-white/10 bg-slate-900/60 p-3"
                  >
                    <div className="flex gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={p.previewUrl}
                        alt=""
                        className="h-20 w-20 rounded object-cover border border-white/20 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        {editingId === p.id ? (
                          <textarea
                            autoFocus
                            value={p.note}
                            onChange={(e) =>
                              setPending((prev) =>
                                prev.map((it) =>
                                  it.id === p.id ? { ...it, note: e.target.value } : it,
                                ),
                              )
                            }
                            onBlur={() => setEditingId(null)}
                            rows={2}
                            placeholder="Caption this photo…"
                            className="w-full rounded-md bg-slate-950 border border-white/15 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingId(p.id)}
                            className="text-left text-sm text-white/80 hover:text-white inline-flex items-start gap-1.5"
                          >
                            <Pencil size={12} className="mt-0.5" aria-hidden />
                            <span>
                              {p.note ? (
                                p.note
                              ) : (
                                <span className="italic text-white/40">
                                  Tap to add a caption (optional)
                                </span>
                              )}
                            </span>
                          </button>
                        )}
                        {p.state === 'error' ? (
                          <p className="mt-1.5 text-xs text-red-400">{p.error}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => removePending(p.id)}
                        className="text-white/50 hover:text-red-400 self-start p-1"
                        aria-label="Remove photo"
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              {batchError ? (
                <p className="mt-3 text-sm text-red-400">{batchError}</p>
              ) : null}

              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStage('shooting')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 transition"
                >
                  ← More photos
                </button>
                <button
                  type="button"
                  onClick={handleAttach}
                  disabled={readyCount === 0}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 active:bg-emerald-600 transition"
                >
                  Attach {readyCount} photo{readyCount === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          ) : null}

          {(stage === 'uploading' || stage === 'done') ? (
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <ul className="space-y-2">
                {pending.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded border border-white/10 bg-slate-900/60 px-3 py-2"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.previewUrl}
                      alt=""
                      className="h-12 w-12 rounded object-cover border border-white/20"
                    />
                    <div className="flex-1 text-sm">
                      <p className="text-white/80 truncate">
                        {p.note?.trim() || attachAllNote.trim() || (
                          <span className="italic text-white/40">No caption</span>
                        )}
                      </p>
                      <p className="text-xs text-white/50 mt-0.5">
                        {p.state === 'uploading'
                          ? 'Uploading…'
                          : p.state === 'uploaded'
                            ? 'Attached'
                            : p.state === 'error'
                              ? p.error
                              : '…'}
                      </p>
                    </div>
                    {p.state === 'uploading' ? (
                      <Loader2 size={16} className="animate-spin text-white/60" aria-hidden />
                    ) : p.state === 'uploaded' ? (
                      <span className="text-emerald-400 text-xs">✓</span>
                    ) : p.state === 'error' ? (
                      <span className="text-red-400 text-xs">!</span>
                    ) : null}
                  </li>
                ))}
              </ul>

              {stage === 'done' ? (
                <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
                  {errorCount > 0 ? (
                    <p className="text-sm text-red-400 mr-auto">
                      {errorCount} photo{errorCount === 1 ? '' : 's'} failed to save — retry,
                      or discard to submit only what saved.
                    </p>
                  ) : evidencePackId ? (
                    // Pack mode: the modal hands off to the durable background
                    // worker, so "uploaded" is not what happened here. Be exact,
                    // and reassure them that leaving is safe.
                    <p className="text-sm text-emerald-400 mr-auto">
                      {handedOffCount} photo{handedOffCount === 1 ? '' : 's'} saved on this
                      device and queued for upload. Safe to close or switch apps.
                    </p>
                  ) : (
                    <p className="text-sm text-emerald-400 mr-auto">
                      All {uploadedCount} photo{uploadedCount === 1 ? '' : 's'} saved.
                    </p>
                  )}
                  {/* No "Done" while failures remain, and no bulk "discard →
                      submit what saved" escape (Outcome 1). Failed evidence
                      must be Retried; abandoning it is only possible via the
                      destructive close confirm, which never implies it saved. */}
                  {errorCount > 0 ? (
                    <button
                      type="button"
                      onClick={retryFailed}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 active:bg-amber-500 transition"
                    >
                      Retry {errorCount} failed
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={finishAndReload}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white active:bg-emerald-600 transition"
                    >
                      Done
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className={launchClass}
        aria-label={launchLabel ?? 'Take photos'}
        disabled={isMisconfigured}
        title={
          isMisconfigured
            ? 'Start a pre-arrival pack first to capture photos here.'
            : undefined
        }
      >
        <Camera size={16} aria-hidden />
        {launchLabel ?? 'Take photos'}
      </button>
      {/* Portal-mount the modal so ancestor transforms / filters
          can't scope our position:fixed to a sub-rect. Guarded by
          typeof document so SSR doesn't blow up. */}
      {typeof document !== 'undefined' && modal
        ? createPortal(modal, document.body)
        : null}
    </>
  )
}
