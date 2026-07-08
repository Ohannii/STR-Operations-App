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
}

/** Tiny client-side id generator (don't import randomUUID — that's Node). */
function makeClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
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
      setPending((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, state: 'error', error: msg } : p,
        ),
      )
    }
  }, [])

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

  const removePending = useCallback((id: string) => {
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
  }, [])

  // --------------------------------------------------------------
  // Modal open/close
  // --------------------------------------------------------------

  const openModal = useCallback(() => {
    setOpen(true)
    setStage('shooting')
    setBatchError(null)
  }, [])

  // Auto-open on mount when the parent passes autoOpen=true. Used
  // by the Action Centre after Start pre-arrival pack — server
  // redirects with capture_now=1, the Action Centre threads that
  // here, and the camera surface comes up without a second tap.
  // Misconfigured callers (no flagId + no packId) are guarded by
  // the disabled launch button check above; we re-check before
  // auto-opening so a stale URL doesn't surface a useless modal.
  useEffect(() => {
    if (autoOpen && !open && !isMisconfigured) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [stopCamera])

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
      try {
        const slot = (await requestPhotoUploadSlot({
          propertyId,
          flagId: flagId ?? null,
          evidencePackId: evidencePackId ?? null,
        })) as UploadSlot | { ok: false; error: string }

        if (!slot.ok) throw new Error(slot.error)

        // Master + thumb in parallel; they're independent objects.
        const put = async (signedUrl: string, blob: Blob) => {
          const res = await fetch(signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
          })
          if (!res.ok) {
            throw new Error(`Upload failed (${res.status}).`)
          }
        }
        await Promise.all([
          put(slot.masterUpload.signedUrl, item.master as Blob),
          put(slot.thumbUpload.signedUrl, item.thumb as Blob),
        ])

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
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.'
        setPending((prev) =>
          prev.map((p) =>
            p.id === item.id ? { ...p, state: 'error', error: msg } : p,
          ),
        )
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
    await runUploads(readyItems)
    setStage('done')
  }, [pending, runUploads])

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
  }, [pending, runUploads, propertyId, stopCamera])

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

  // --------------------------------------------------------------
  // Render
  // --------------------------------------------------------------

  // Pre-arrival pack capture sessions require a packId — fail
  // closed if a caller forgets it. Flag captures don't need a pack.
  const isMisconfigured = !flagId && !evidencePackId

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
                onClick={closeModal}
                className="rounded-full p-1.5 hover:bg-white/10 transition"
                aria-label="Close camera"
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
                <div className="mt-5 flex items-center justify-end gap-3">
                  {errorCount > 0 ? (
                    <p className="text-sm text-red-400 mr-auto">
                      {errorCount} photo{errorCount === 1 ? '' : 's'} failed to attach.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={finishAndReload}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white active:bg-emerald-600 transition"
                  >
                    Done
                  </button>
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
