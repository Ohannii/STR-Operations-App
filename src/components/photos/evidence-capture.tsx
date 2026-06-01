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
import { Camera, Image as ImageIcon, Loader2, Pencil, Trash2, X } from 'lucide-react'
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
   */
  raiseFlagHref?: string | null
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
}: Props) {
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
  // The React 19 react-hooks/set-state-in-effect rule fires because
  // startCamera() synchronously calls setCameraError(null) +
  // setCameraReady(false) before awaiting getUserMedia. That's
  // exactly what we want — reset the visible state before kicking
  // off the async permission flow. Deferring via queueMicrotask
  // would only hide the same calls from the linter without changing
  // behaviour.
  useEffect(() => {
    if (open && stage === 'shooting') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void startCamera()
    } else {
      stopCamera()
    }
    return () => {
      stopCamera()
    }
  }, [open, stage, startCamera, stopCamera])

  // Revoke object URLs when pending items change or modal closes.
  useEffect(() => {
    return () => {
      for (const p of pending) URL.revokeObjectURL(p.previewUrl)
    }
    // Intentionally not depending on `pending`; cleanup runs on unmount only.
    // Per-item revoke happens inside removePending().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const handleAttach = useCallback(async () => {
    const readyItems = pending.filter((p) => p.state === 'ready' && p.master && p.thumb)
    if (readyItems.length === 0) {
      setBatchError('Nothing to attach yet. Wait for the photos to finish processing.')
      return
    }
    setStage('uploading')
    setBatchError(null)

    // Sequential upload keeps mobile-network pressure low and gives
    // a predictable progress indicator. Parallel would be faster on
    // wifi but riskier on flaky signal.
    for (const item of readyItems) {
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

        // PUT the master and thumb directly to Supabase Storage.
        // Use the raw signed URL — supabase-js's uploadToSignedUrl
        // requires the bucket/path arg pattern; the raw URL is
        // simpler and works the same. Master + thumb run in parallel
        // because they're independent objects — roughly halves the
        // per-photo upload time on a single phone connection.
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

        const finalNote = (item.note?.trim() || attachAllNote.trim() || null) as string | null

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.'
        setPending((prev) =>
          prev.map((p) =>
            p.id === item.id ? { ...p, state: 'error', error: msg } : p,
          ),
        )
      }
    }

    setStage('done')
  }, [pending, propertyId, flagId, evidencePackId, attachAllNote])

  const finishAndReload = useCallback(() => {
    closeModal()
    // Server actions already revalidatePath the relevant routes.
    // A hard reload here keeps the URL clean (no ?refreshed=1) and
    // is acceptable UX after a multi-photo batch.
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }, [closeModal])

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
      ? 'inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 active:bg-slate-950 disabled:opacity-50 disabled:cursor-not-allowed transition'
      : 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition'

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

      {open ? (
        <div
          className="fixed inset-0 z-50 bg-slate-950/95 text-white flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="Evidence capture"
        >
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-950/70 backdrop-blur">
            <p className="text-sm font-medium">
              {stage === 'shooting'
                ? `${pending.length} photo${pending.length === 1 ? '' : 's'}`
                : stage === 'reviewing'
                  ? `Review ${pending.length} photo${pending.length === 1 ? '' : 's'}`
                  : stage === 'uploading'
                    ? `Uploading ${uploadingCount}…  (${uploadedCount}/${pending.length} done)`
                    : `Attached ${uploadedCount} photo${uploadedCount === 1 ? '' : 's'}`}
            </p>
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

          {/* Body */}
          {stage === 'shooting' ? (
            <div className="flex-1 flex flex-col">
              {/* Camera preview */}
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

                <button
                  type="button"
                  onClick={handleShutter}
                  disabled={!cameraReady}
                  className="h-16 w-16 rounded-full bg-white text-slate-950 disabled:opacity-40 active:scale-95 transition flex items-center justify-center shadow-xl border-4 border-white/30"
                  aria-label="Take photo"
                >
                  <span className="block h-12 w-12 rounded-full bg-white border-2 border-slate-950" />
                </button>

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

              {/* Raise-flag affordance on the review screen.
                  Honest scope: this LINKS to the existing flag-
                  creation workflow. The current pack photos stay
                  on the pack — they're not auto-copied to the new
                  flag. The flag's own evidence section is the
                  right place to attach flag-specific photos. */}
              {raiseFlagHref ? (
                <div className="mt-4 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2.5">
                  <p className="text-xs text-amber-100 leading-relaxed">
                    Spotted an issue in these photos? Raise a flag — the photos
                    above stay attached to the pack, and you can attach flag-
                    specific photos directly from the new flag.
                  </p>
                  <a
                    href={raiseFlagHref}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-400 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-amber-300 transition"
                  >
                    Raise a flag →
                  </a>
                </div>
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
      ) : null}
    </>
  )
}
