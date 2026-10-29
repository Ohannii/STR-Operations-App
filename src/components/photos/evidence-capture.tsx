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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  Camera,
  Check,
  Flag,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { compressForEvidence } from '@/lib/photos/compress'
import { dbg, timed } from '@/lib/photos/photo-queue-debug'
import { packCapture } from '@/lib/photos/pack-capture-store'
import { PhotoQueueUnavailableError } from '@/lib/photos/photo-queue-db'
import {
  drainQueue,
  enqueuePhoto,
  releaseQueued,
  requestDiscard,
  retryFailed as retryQueueFailed,
  updateQueuedNote,
  usePackQueue,
} from '@/lib/photos/photo-queue'
import {
  BATCH_NOTE_UNSAFE_ID,
  CaptureNoteKeeper,
  readBatchNote,
} from '@/lib/photos/capture-note-shadow'
import {
  MAX_CAPTION_LENGTH,
  canonicalCaption,
  canonicalCaptionOrNull,
} from '@/lib/photos/caption-canonical'
import {
  CaptureExitGate,
  handOffPackRelease,
  idsToHandOff,
  packRowStatus,
  hasUnsavedCaptureWork,
  photosToWarnOnClose,
  planCaptureExit,
  type CapturePhotoLite,
  type CaptureToken,
} from '@/lib/photos/capture-handoff'
import {
  evaluateBatch,
  isExhausted,
  packScopeError,
  reviewReadiness,
  thumbBadge,
  type QueuedPhotoMeta,
} from '@/lib/photos/photo-queue-state'
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

/** rev 9: the exit gate's view of a capture photo. */
function toCapturePhotos(items: readonly Pending[]): CapturePhotoLite[] {
  return items.map((p) => ({ id: p.id, state: p.state, hasBytes: Boolean(p.master && p.thumb) }))
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
  // NOTE: `autoOpen` is intentionally GONE (P0, 21 Jul 2026). A URL-carried
  // auto-open outlives its moment (Next.js router state keeps the param after
  // history.replaceState) and kept reopening the camera on refresh/remount.
  // The camera opens ONLY from an explicit tap on the launch button.
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
  startInGalleryMode = false,
  userId,
  companyId,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  // "Note for all photos" (rev 5): restored from device storage after a
  // kill/reopen. The review UI only renders after the modal opens on the
  // client, so this initial read cannot cause a hydration mismatch.
  const [attachAllNote, setAttachAllNote] = useState(() =>
    evidencePackId ? (readBatchNote(evidencePackId) ?? '') : '',
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [stage, setStage] = useState<'shooting' | 'reviewing' | 'uploading' | 'done'>(
    'shooting',
  )
  const [batchError, setBatchError] = useState<string | null>(null)
  /**
   * Pack mode: the EXACT logical photo ids released to the worker in THIS
   * modal session (across repeated "More photos → Attach" rounds), minus any
   * the inspector removed. This is what the honest Done gate counts: Done
   * means every one of THESE ids is server-attached — never "queued", never
   * "saved on this device". Historical/unrelated queue records don't block.
   */
  const [batchIds, setBatchIds] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * rev 9 — ONE single-flight exit gate shared by Attach and Report issue.
   * It is claimed SYNCHRONOUSLY before any await (a second tap on either
   * button does nothing) and it holds the session's PROVEN handed-off set,
   * merged synchronously — handlers read it at call time, never from a
   * stale render, and an older completion can only add proven ids.
   * `batchIds` above is its render mirror.
   */
  const [exitGate] = useState(() => new CaptureExitGate())
  const [exiting, setExiting] = useState(false)
  /**
   * rev 10 — PRE-PENDING CAPTURE WORK. A shutter photo is not in pending[]
   * until canvas.toBlob() has called back, and a gallery pick reads files one
   * by one. Each capture claims a token on the SAME gate synchronously,
   * before its first await, and holds it until its ingest has finished
   * (durable/ready or error). While any token is live, Attach and Report
   * issue cannot claim the gate and Close cannot close. Render mirror below.
   */
  const [captureWork, setCaptureWork] = useState(0)
  const claimCapture = useCallback((): CaptureToken | null => {
    const token = exitGate.beginCapture() // null while an exit holds the gate
    if (token) setCaptureWork(exitGate.captureWork)
    return token
  }, [exitGate])
  const releaseCapture = useCallback(
    (token: CaptureToken) => {
      exitGate.endCapture(token) // only THIS token; an old session's is inert
      setCaptureWork(exitGate.captureWork)
    },
    [exitGate],
  )

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  // CAPTION DURABILITY (P0, 22 Oct 2026; rev 3, 23 Oct): every pack-capture
  // caption keystroke goes through CaptureNoteKeeper (capture-note-shadow.ts,
  // behaviour-tested without a DOM):
  //   1. SYNCHRONOUSLY, before the handler returns, a localStorage shadow is
  //      written with a unique edit identity and a version above the
  //      PERSISTED per-photo high-water mark (survives remounts, tabs and
  //      clock rollback) — a page kill on the next instruction loses nothing;
  //   2. the same version is debounce-persisted into the IndexedDB record
  //      (immediately on blur, using the textarea's CURRENT DOM value);
  //   3. the "not yet safe" warning clears only when the LATEST edit identity
  //      is provably durable — an older success can never vouch for it.
  // Flag capture (no evidencePackId) has no queue and is unchanged.
  const [noteUnsafeIds, setNoteUnsafeIds] = useState<ReadonlySet<string>>(() => new Set())
  const noteKeeper = useMemo(
    () =>
      evidencePackId
        ? new CaptureNoteKeeper({
            packId: evidencePackId,
            scope: { userId: userId ?? '', companyId: companyId ?? '', propertyId },
            persistToQueue: updateQueuedNote,
            onUnsafeChange: (ids) => setNoteUnsafeIds(ids),
          })
        : null,
    [evidencePackId, userId, companyId, propertyId],
  )
  useEffect(() => {
    return () => noteKeeper?.dispose() // flushes pending IndexedDB writes
  }, [noteKeeper])

  // Live device-queue state for THIS pack. Staging runs from the moment of
  // capture, and these records carry bytesStaged — that is what draws the
  // per-photo "uploaded" checkmarks on the strip and review list. Safe with ''
  // (flag capture): snapshot is empty and the worker no-ops.
  const packQueue = usePackQueue(evidencePackId ?? '')
  // Depend on the records ARRAY itself (a stable snapshot that gets a new
  // identity on every queue change), not on the wrapper object. The memo
  // recomputes exactly when the queue changes and sets no state, so badge
  // updates stay live with no render loop.
  const queueRecords = packQueue.records
  const queueRecordById = useMemo(() => {
    const m = new Map<string, QueuedPhotoMeta>()
    for (const r of queueRecords) m.set(r.id, r)
    return m
  }, [queueRecords])
  const galleryInputRef = useRef<HTMLInputElement | null>(null)

  // HONEST DONE GATE (pack mode) — pure logic in evaluateBatch (unit-tested):
  // a batch id counts attached only when its record is gone AND it is not in
  // the worker's discarded ledger; unhydrated fails closed; removed photos
  // left the batch; exhausted failures block Done and surface ONCE, calmly.
  const discardedIdSet = useMemo(
    () => new Set(packQueue.discardedIds),
    [packQueue.discardedIds],
  )
  const batch = useMemo(
    () => evaluateBatch(batchIds, queueRecords, packQueue.hydrated, discardedIdSet),
    [batchIds, queueRecords, packQueue.hydrated, discardedIdSet],
  )

  // ATTACH GATE (P0): Attach stays disabled until every retained review photo
  // has its bytes CONFIRMED on the server (or already attached). Releasing
  // mid-staging is what collided with the staging lease and stalled fresh
  // uploads for minutes; now Attach unlocks exactly when it can be fast.
  // rev 9: readiness is computed over the EXIT PLAN, never over the ready
  // subset alone — one ready photo can no longer enable Attach while another
  // is still compressing or has failed.
  const capturePhotos = useMemo(() => toCapturePhotos(pending), [pending])
  const exitPlan = useMemo(
    () => planCaptureExit(capturePhotos, batchIds, evidencePackId ? 'pack' : 'flag', captureWork),
    [capturePhotos, batchIds, evidencePackId, captureWork],
  )
  const readyIds = exitPlan.eligibleIds
  const readiness = useMemo(
    () =>
      evidencePackId
        ? reviewReadiness(readyIds, queueRecords, packQueue.hydrated)
        : { ready: readyIds.length > 0, prepared: readyIds.length, total: readyIds.length },
    [evidencePackId, readyIds, queueRecords, packQueue.hydrated],
  )
  const canAttach =
    !exiting &&
    exitPlan.allowed &&
    (readyIds.length > 0 ? readiness.ready : Boolean(evidencePackId) && batchIds.size > 0)

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

  const ingestBlob = useCallback(async (rawBlob: Blob, capturedAt: string, token: CaptureToken) => {
    // rev 10: a capture from a CLOSED session never joins a reopened one.
    if (!exitGate.isCurrent(token)) return
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
      const compressed = await timed('compress', id, () => compressForEvidence(rawBlob))
      dbg('compress:size', { photoId: id, bytes: compressed.master.size })

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
        // A photo captured after the batch note was entered INHERITS it,
        // durably and at once (rev 5) — not only when Attach is tapped.
        noteKeeper?.registerPhoto(id)
        // UPLOAD EARLY: kick the worker so this photo's bytes start moving
        // to the server WHILE the inspector keeps shooting. The photo is not
        // attached yet — it stays discardable and its note still rides the
        // attach — but by the time they tap Attach most bytes are already
        // up, which is what made the old flow feel fast.
        void drainQueue(evidencePackId)
      }

      // rev 10: session closed meanwhile — touch nothing here. (A pack photo
      // that already reached IndexedDB stays recoverable from the pack
      // page's "Attach saved photos".)
      if (!exitGate.isCurrent(token)) {
        URL.revokeObjectURL(previewUrl)
        return
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
      if (!exitGate.isCurrent(token)) return // closed session: nothing to show
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
  }, [evidencePackId, userId, companyId, propertyId, noteKeeper, exitGate])

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
    // rev 10: claim capture work BEFORE the first await (canvas.toBlob) and
    // hold it until the ingest finished — no exit can see an empty session
    // while this photo exists only in a canvas callback.
    const token = claimCapture()
    if (!token) return // an exit holds the gate: no new capture may start
    try {
      ctx.drawImage(video, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
      )
      if (!blob || !exitGate.isCurrent(token)) return
      await ingestBlob(blob, new Date().toISOString(), token)
    } finally {
      releaseCapture(token) // success, null blob, error or closed session
    }
  }, [cameraReady, ingestBlob, claimCapture, releaseCapture, exitGate])

  const handleGallery = useCallback(
    async (files: FileList | null) => {
      if (!files) return
      // rev 10: ONE claim for the whole selection, taken before the first
      // await and held until EVERY selected image has finished ingesting.
      const token = claimCapture()
      if (!token) return
      try {
        for (const file of Array.from(files)) {
          if (!exitGate.isCurrent(token)) break // session closed meanwhile
          if (!file.type.startsWith('image/')) continue
          const capturedAt = file.lastModified
            ? new Date(file.lastModified).toISOString()
            : new Date().toISOString()
          await ingestBlob(file, capturedAt, token)
        }
      } finally {
        releaseCapture(token)
      }
    },
    [ingestBlob, claimCapture, releaseCapture, exitGate],
  )

  const removePending = useCallback(
    (id: string) => {
      // Release the logical photo from the pack intent map (no-op if it was
      // never committed). Does not lower the persisted target.
      if (evidencePackId) packCapture.remove(evidencePackId, id)
      exitGate.forget(id) // a removed photo leaves the session's proven set
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
      // Pack capture: the photo also lives in the durable device queue and —
      // because staging starts at capture — a server intent MAY exist or be
      // mid-creation right now. The UI therefore NEVER deletes the record or
      // calls the server itself: it persists a durable discard request and
      // the queue worker owns the cleanup (abort in-flight work at the next
      // boundary → server discard → local delete only after confirmation).
      // If it fails or we're offline it stays visible as "Removing…" and
      // retries — nothing is hidden, nothing is left for manual cleanup.
      if (evidencePackId) {
        void requestDiscard(
          evidencePackId,
          id,
          'Removed by inspector on the capture review screen',
        )
      }
      // A deliberately removed photo leaves the batch: it must not be part
      // of the Done gate's required total.
      setBatchIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [evidencePackId, exitGate],
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
  const isMisconfigured = !flagId && !evidencePackId

  // NO AUTO-OPEN. The camera opens ONLY from the explicit launch-button tap
  // (openModal). Two shipped attempts to make URL-driven auto-open one-shot
  // (strip the param, then a per-mount consumed ref) both failed the same
  // way: the instruction outlived its moment in Next's router state, and any
  // remount re-opened the camera over the inspector's work. The behaviour is
  // deleted, not patched again.

  const closeModal = useCallback(() => {
    stopCamera()
    setOpen(false)
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.previewUrl)
      return []
    })
    // Session over: the fallback already lives in each photo's own record,
    // so only the pack-level batch key is removed (photos untouched).
    noteKeeper?.forgetBatchNote()
    setAttachAllNote('')
    setStage('shooting')
    setEditingId(null)
    setBatchError(null)
    exitGate.reset() // new session identity: late old captures are inert
    setCaptureWork(0)
    setBatchIds(new Set())
  }, [stopCamera, noteKeeper, exitGate])

  // Dismiss guard (req 8): closing a session that still holds unattached,
  // uploading or failed photos requires an explicit DESTRUCTIVE confirm and
  // never implies they were saved. On confirm, those logical photos are
  // released from the pack intent map (the persisted target is unchanged, so
  // the pack still requires those photos be recaptured before it can submit).
  const dismiss = useCallback(() => {
    // Never close mid-handoff, nor while a capture is still being prepared
    // (rev 10: it may not even be in pending[] yet).
    if (exitGate.inFlight || exitGate.captureWork > 0) return
    // rev 9: once the batch is COMPLETE (server-attached) its photos are not
    // "NOT attached"; anything genuinely outstanding still warns.
    const warnIds = new Set(
      photosToWarnOnClose(
        toCapturePhotos(pending),
        exitGate.handedOff(),
        evidencePackId ? 'pack' : 'flag',
        batch.complete,
      ),
    )
    const unresolved = pending.filter((p) => warnIds.has(p.id))
    if (unresolved.length > 0) {
      // Chosen durable outcome for close/reload with unreleased photos
      // (pack mode): records STAY in the device queue as saved_local and the
      // pack page's queue panel restores them visibly with "Attach N saved
      // photos". Nothing is discarded and no hidden state is left — so say
      // exactly that. Flag capture has no durable queue, so there the photos
      // really are discarded and the warning stays sharp.
      const ok =
        typeof window === 'undefined' ||
        window.confirm(
          evidencePackId
            ? `${unresolved.length} photo${unresolved.length === 1 ? '' : 's'} ` +
                `${unresolved.length === 1 ? 'is' : 'are'} NOT attached to the pack yet. ` +
                `Photos that finished saving on this device can be attached from the ` +
                `pack page ("Attach saved photos"); any still processing or failed ` +
                `will be lost. Close?`
            : `${unresolved.length} photo${unresolved.length === 1 ? '' : 's'} ` +
                `${unresolved.length === 1 ? 'has' : 'have'} NOT been saved and ` +
                `will be discarded. Close anyway?`,
        )
      if (!ok) return
      if (evidencePackId) {
        for (const p of unresolved) packCapture.remove(evidencePackId, p.id)
      }
    }
    closeModal()
  }, [pending, evidencePackId, closeModal, exitGate, batch.complete])

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

        // Create-only Storage duplicates CONVERGE (P0, 22 Jul night): a 409,
        // a 400 whose body says "already exists"/"Duplicate", or a NULL
        // upload slot (server verified the object exists) all mean the bytes
        // already landed — done, never fatal. Skip anything already PUT.
        const putOnce = async (
          upload: { signedUrl: string } | null,
          blob: Blob,
          already: boolean,
        ) => {
          if (already || !upload) return
          const res = await fetch(upload.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
          })
          if (!res.ok && res.status !== 409) {
            const body = await res.text().catch(() => '')
            if (/already exists|duplicate/i.test(body)) return
            throw new Error(`Upload failed (${res.status}).`)
          }
        }
        await putOnce(slot.masterUpload, item.master as Blob, !!item.masterDone)
        setPending((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, masterDone: true } : p)),
        )
        await putOnce(slot.thumbUpload, item.thumb as Blob, !!item.thumbDone)
        setPending((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, thumbDone: true } : p)),
        )

        if (evidencePackId) packCapture.mark(evidencePackId, item.id, 'attaching')
        const finalNote =
          canonicalCaptionOrNull(item.note) ?? canonicalCaptionOrNull(attachAllNote)

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
    // SINGLE FLIGHT (rev 9): claimed synchronously, before ANY await. A second
    // tap on Attach or Report issue returns here and does nothing.
    if (!exitGate.tryEnter()) return
    setExiting(true)
    try {
      // EXIT PLAN (rev 9): never proceed with a partial subset while another
      // photo is still processing or has failed — and never resend a photo
      // already proven handed off.
      const plan = planCaptureExit(
        toCapturePhotos(pending),
        exitGate.handedOff(),
        evidencePackId ? 'pack' : 'flag',
      )
      if (!plan.allowed) {
        setBatchError(plan.blockedMessage)
        setStage('reviewing')
        return
      }
      const eligible = new Set(plan.eligibleIds)
      const readyItems = pending.filter((p) => eligible.has(p.id))
      if (readyItems.length === 0 && !(evidencePackId && exitGate.handedOff().size > 0)) {
        setBatchError('Nothing to attach yet.')
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
        // rev 8: hand off ONLY photos not already PROVEN handed off this
        // session — a photo attached in an earlier round is never resent (its
        // record is gone because it attached, which is not a failure).
        const intended = idsToHandOff(
          readyItems.map((it) => it.id),
          exitGate.handedOff(),
        )
        if (intended.length === 0) {
          void drainQueue(evidencePackId)
          setStage('done')
          return
        }
        // In-session submit gate: these photos are now unresolved until the
        // queue attaches them, the inspector removes them, or the session is
        // dismissed. A FAILED handoff keeps them committed on purpose (they
        // really are unattached); every exit path releases them — removePending
        // and the dismiss confirm call packCapture.remove, and the map is
        // in-memory only, so a reload falls back to server truth. It can
        // therefore never block the pack permanently.
        for (const id of intended) packCapture.commit(evidencePackId, id)
        const intendedSet = new Set(intended)
        const notes: Record<string, string | null> = {}
        for (const it of readyItems) {
          if (!intendedSet.has(it.id)) continue
          notes[it.id] = canonicalCaptionOrNull(it.note) ?? canonicalCaptionOrNull(attachAllNote)
        }
        // ONE fail-closed handoff (rev 5, capture-handoff.ts). The release is
        // deadline-bounded (never hostage), so the screen can afford to WAIT
        // for its proof.
        const handoff = await handOffPackRelease({
          packId: evidencePackId,
          notes,
          secureRelease: noteKeeper ? (n) => noteKeeper.secureRelease(n) : undefined,
          release: releaseQueued,
        })
        // EXACT COVERAGE (rev 8): ONLY photos PROVEN handed off join the batch
        // the Done gate counts. A missing or unproven photo never does, so the
        // gate can never read "record absent" as "attached" for it.
        // Merged into the gate SYNCHRONOUSLY (rev 9): an older completion can
        // only add proven ids; the render mirror is the gate's latest set.
        const outcome = exitGate.record(intended, handoff)
        setBatchIds(outcome.handedOff)
        void drainQueue(evidencePackId) // proven photos keep moving
        if (outcome.next === 'review') {
          // Partial or failed: the failed photos stay HERE, visible and
          // retryable (Attach again resends only them).
          setBatchError(handoff.ok ? null : handoff.message)
          dbg('release:handoff-failed', { detail: handoff.ok ? 'none' : handoff.reason })
          setStage('reviewing')
          return
        }
        setStage('done')
        return
      }

      await runUploads(readyItems)
      setStage('done')
    } finally {
      exitGate.leave()
      setExiting(false)
    }
  }, [pending, runUploads, evidencePackId, attachAllNote, noteKeeper, exitGate])

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
    // SINGLE FLIGHT (rev 9): claimed synchronously, before ANY await.
    if (!exitGate.tryEnter()) return
    let navigating = false
    setExiting(true)
    try {
      // EXIT PLAN (rev 9): a full-page navigation would kill a photo still
      // compressing / being stored, so Report issue never leaves while any
      // not-yet-handed-off photo is processing or failed. An EMPTY session may
      // report an issue without photos.
      const plan = planCaptureExit(
        toCapturePhotos(pending),
        exitGate.handedOff(),
        evidencePackId ? 'pack' : 'flag',
      )
      if (!plan.allowed) {
        setBatchError(plan.blockedMessage)
        setStage('reviewing')
        return
      }
      const eligible = new Set(plan.eligibleIds)
      const readyItems = pending.filter((p) => eligible.has(p.id))
      if (readyItems.length > 0 && evidencePackId) {
        // PACK MODE = ONE PIPELINE (P0, 22 Jul night). This shortcut used to
        // run the LEGACY in-modal uploader, which re-requested slots for
        // already-staged photos — create-only Storage answered "The resource
        // already exists" and 25 safely-uploaded photos were declared failed.
        // Packs now release to the durable queue exactly like Attach; the
        // worker finishes (idempotently) in the background while we navigate,
        // and the pack page's panel shows live progress.
        setBatchError(null)
        // rev 8: never resend a photo already PROVEN handed off this session.
        const intended = idsToHandOff(
          readyItems.map((it) => it.id),
          exitGate.handedOff(),
        )
        if (intended.length > 0) {
          for (const id of intended) packCapture.commit(evidencePackId, id)
          const intendedSet = new Set(intended)
          const notes: Record<string, string | null> = {}
          for (const it of readyItems) {
            if (!intendedSet.has(it.id)) continue
            notes[it.id] = canonicalCaptionOrNull(it.note) ?? canonicalCaptionOrNull(attachAllNote)
          }
          // FAIL CLOSED (rev 5/8): flag creation is reached ONLY when EVERY
          // intended photo is proven handed to the queue. Any refusal, unsafe
          // caption, thrown release, missing or unreadable photo keeps the
          // inspector HERE, on the review screen — never a silent navigate.
          const handoff = await handOffPackRelease({
            packId: evidencePackId,
            notes,
            secureRelease: noteKeeper ? (n) => noteKeeper.secureRelease(n) : undefined,
            release: releaseQueued,
          })
          const outcome = exitGate.record(intended, handoff)
          setBatchIds(outcome.handedOff)
          void drainQueue(evidencePackId) // proven photos keep moving either way
          if (!handoff.ok || outcome.next !== 'done') {
            setBatchError(handoff.ok ? null : handoff.message)
            setStage('reviewing')
            return
          }
        }
      } else if (readyItems.length > 0) {
        // FLAG capture keeps its original in-memory pipeline.
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
      navigating = true
      stopCamera()
      if (typeof window !== 'undefined') {
        const target = `/properties/${propertyId}/flags/new`
        // Diagnostic — if the user reports a 404 after this we can
        // see in dev tools whether the URL was malformed (e.g.
        // propertyId got dropped to undefined).
        console.info('[EvidenceCapture] navigating to raise-flag:', target)
        window.location.href = target
      }
    } finally {
      // Once navigation has started the gate stays CLAIMED: no second
      // handoff or navigation can begin while the page unloads.
      if (!navigating) {
        exitGate.leave()
        setExiting(false)
      }
    }
  }, [pending, runUploads, propertyId, stopCamera, evidencePackId, attachAllNote, noteKeeper, exitGate])

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

  const uploadingCount = pending.filter((p) => p.state === 'uploading').length
  const uploadedCount = pending.filter((p) => p.state === 'uploaded').length
  const errorCount = pending.filter((p) => p.state === 'error').length
  const isMidUpload = stage === 'uploading'

  // Warn before leaving/reloading while there is unsaved photo work
  // (captured/selected/failed but not yet linked). These compressed
  // blobs live only in memory — a reload would lose them silently, which
  // is exactly how evidence went missing. Native beforeunload only; no
  // new deps, and it self-removes once everything is saved.
  // rev 10: includes `compressing` (the only interval before pack bytes are
  // durable in IndexedDB) and captures not yet in pending[] at all.
  const hasUnsavedWork = hasUnsavedCaptureWork(capturePhotos, captureWork)
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
                      ? batch.complete
                        ? `${batch.total} photo${batch.total === 1 ? '' : 's'} attached`
                        : `${batch.outstanding} photo${batch.outstanding === 1 ? '' : 's'} left to attach…`
                      : `Attached ${uploadedCount} photo${uploadedCount === 1 ? '' : 's'}`}
            </p>
            <div className="flex items-center gap-2">
              {raiseFlagHref && (stage === 'shooting' || stage === 'reviewing') ? (
                <button
                  type="button"
                  onClick={handleRaiseFlag}
                  // rev 9: disabled while a handoff is in flight or a photo
                  // is still being prepared (a navigation would kill it).
                  disabled={exiting || exitPlan.preparing}
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 text-slate-950 px-2.5 py-1.5 text-xs font-semibold hover:bg-amber-300 active:bg-amber-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  title={
                    exitPlan.blockedMessage ??
                    'Attach pending photos to the pack, then open the report-issue workflow'
                  }
                >
                  {exiting ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Flag size={13} aria-hidden />
                  )}
                  {exitPlan.preparing ? 'Preparing photos…' : 'Report issue'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full p-1.5 hover:bg-white/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close camera"
                // Disabled during an active upload batch or a handoff in
                // flight (rev 9); otherwise closing with unattached/failed
                // photos goes through the destructive confirm in `dismiss`.
                disabled={isMidUpload || exiting || captureWork > 0}
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
                        {/* Truthful badge from the DURABLE QUEUE RECORD, never
                            from "the device is online". */}
                        {evidencePackId && p.state === 'ready'
                          ? (() => {
                              const badge = thumbBadge(
                                queueRecordById.get(p.id),
                                packQueue.online,
                              )
                              if (badge === 'uploaded')
                                return (
                                  <span
                                    className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500 text-white p-0.5 border border-slate-950"
                                    aria-label="Ready to attach"
                                  >
                                    <Check size={9} aria-hidden />
                                  </span>
                                )
                              if (badge === 'uploading')
                                return (
                                  <span
                                    className="absolute -bottom-1 -right-1 rounded-full bg-slate-800/90 text-white/80 p-0.5 border border-white/30"
                                    aria-label="Uploading"
                                  >
                                    <Loader2 size={9} className="animate-spin" aria-hidden />
                                  </span>
                                )
                              if (badge === 'failed')
                                return (
                                  <span
                                    className="absolute -bottom-1 -right-1 rounded-full bg-red-600 text-white p-0.5 border border-slate-950 text-[8px] leading-none font-bold w-3.5 h-3.5 flex items-center justify-center"
                                    aria-label="Upload failed"
                                  >
                                    !
                                  </span>
                                )
                              return null // saved_device / removing: no strip badge
                            })()
                          : null}
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          disabled={exiting || p.state === 'compressing'}
                          className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-950 border border-white/30 p-0.5 hover:bg-red-600 transition disabled:opacity-40"
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
                  disabled={exiting}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-xs font-medium text-white/80 hover:bg-white/10 transition disabled:opacity-40"
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
                    disabled={!cameraReady || exiting}
                    className="h-16 w-16 rounded-full bg-white text-slate-950 disabled:opacity-40 active:scale-95 transition flex items-center justify-center shadow-xl border-4 border-white/30"
                    aria-label="Take photo"
                  >
                    <span className="block h-12 w-12 rounded-full bg-white border-2 border-slate-950" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setStage('reviewing')}
                  disabled={pending.length === 0 || exiting}
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
                  readOnly={exiting}
                  maxLength={MAX_CAPTION_LENGTH}
                  onChange={(e) => {
                    const text = e.target.value
                    setAttachAllNote(text)
                    // Durable at once + propagated to photos with no own caption.
                    noteKeeper?.setBatchNote(text)
                  }}
                  placeholder="e.g. Stain on couch — see angles 1–3"
                  rows={2}
                  className="w-full rounded-md bg-slate-900 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                {noteUnsafeIds.has(BATCH_NOTE_UNSAFE_ID) ? (
                  <p className="mt-1 text-[11px] text-amber-400">
                    This note is not yet safe on this device — keep this screen
                    open until the photos are attached.
                  </p>
                ) : null}
              </div>

              <ul className="space-y-3">
                {pending.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-lg border border-white/10 bg-slate-900/60 p-3"
                  >
                    <div className="flex gap-3">
                      <div className="relative shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={p.previewUrl}
                          alt=""
                          className="h-20 w-20 rounded object-cover border border-white/20"
                        />
                        {evidencePackId && p.state === 'ready'
                          ? (() => {
                              const badge = thumbBadge(
                                queueRecordById.get(p.id),
                                packQueue.online,
                              )
                              // Hotfix: `uploaded` = bytes in cloud storage, NOT
                              // attached to the pack yet — so the inspector sees
                              // "Ready" (to attach), never "Uploaded".
                              if (badge === 'uploaded')
                                return (
                                  <span className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded bg-emerald-500/95 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                    <Check size={9} aria-hidden /> Ready
                                  </span>
                                )
                              if (badge === 'uploading')
                                return (
                                  <span className="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded bg-slate-800/95 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                                    <Loader2 size={9} className="animate-spin" aria-hidden />
                                    Uploading
                                  </span>
                                )
                              if (badge === 'failed')
                                return (
                                  <span className="absolute bottom-1 right-1 inline-flex items-center rounded bg-red-600/95 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                    Failed — will retry
                                  </span>
                                )
                              if (badge === 'removing')
                                return (
                                  <span className="absolute bottom-1 right-1 inline-flex items-center rounded bg-slate-800/95 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                                    Removing…
                                  </span>
                                )
                              if (badge === 'saved_device')
                                return (
                                  <span className="absolute bottom-1 right-1 inline-flex items-center rounded bg-slate-800/95 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                                    Saved on device
                                  </span>
                                )
                              return null
                            })()
                          : null}
                      </div>
                      <div className="flex-1 min-w-0">
                        {editingId === p.id ? (
                          <textarea
                            autoFocus
                            value={p.note}
                            readOnly={exiting}
                            maxLength={MAX_CAPTION_LENGTH}
                            onChange={(e) => {
                              const text = e.target.value
                              setPending((prev) =>
                                prev.map((it) =>
                                  it.id === p.id ? { ...it, note: text } : it,
                                ),
                              )
                              // Shadow written SYNCHRONOUSLY, before return.
                              noteKeeper?.change(p.id, text)
                            }}
                            onBlur={(e) => {
                              // The textarea's CURRENT value — never the
                              // possibly-stale render value p.note.
                              const current = e.currentTarget.value
                              setEditingId(null)
                              noteKeeper?.blur(p.id, current)
                            }}
                            rows={2}
                            placeholder="Caption this photo…"
                            className="w-full rounded-md bg-slate-950 border border-white/15 px-2.5 py-1.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingId(p.id)}
                            disabled={exiting}
                            className="text-left text-sm text-white/80 hover:text-white inline-flex items-start gap-1.5 disabled:opacity-60"
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
                        {noteUnsafeIds.has(p.id) ? (
                          <p className="mt-1 text-[11px] text-amber-400">
                            Caption not yet safe on this device — keep this
                            screen open until the photos are attached.
                          </p>
                        ) : null}
                        {p.state === 'error' ? (
                          <p className="mt-1.5 text-xs text-red-400">{p.error}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => removePending(p.id)}
                        disabled={exiting || p.state === 'compressing'}
                        className="text-white/50 hover:text-red-400 self-start p-1 disabled:opacity-40"
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
              {/* rev 9: the truthful reason Attach / Report issue are held. */}
              {exitPlan.blockedMessage && exitPlan.blockedMessage !== batchError ? (
                <p className="mt-3 text-sm text-amber-400" role="status">
                  {exitPlan.blockedMessage}
                </p>
              ) : null}

              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStage('shooting')}
                  disabled={exiting}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/10 transition disabled:opacity-40"
                >
                  ← More photos
                </button>
                <button
                  type="button"
                  onClick={handleAttach}
                  disabled={!canAttach}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed active:bg-emerald-600 transition"
                >
                  {exiting
                    ? 'Attaching…'
                    : exitPlan.preparing
                    ? 'Preparing photos…'
                    : exitPlan.failedIds.length > 0
                    ? 'Remove failed photos first'
                    : readyIds.length === 0 && canAttach
                    ? 'Continue'
                    : readiness.ready
                    ? `Attach ${readiness.total} photo${readiness.total === 1 ? '' : 's'}`
                    : readiness.total === 0
                      ? // Never the dead "Preparing photos… 0 of 0" (P0, 22
                        // Jul night): with nothing ready there is nothing to
                        // prepare — plain disabled label.
                        'Attach photos'
                      : `Preparing photos… ${readiness.prepared} of ${readiness.total}`}
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
                        {canonicalCaption(p.note) || canonicalCaption(attachAllNote) || (
                          <span className="italic text-white/40">No caption</span>
                        )}
                      </p>
                      <p className="text-xs text-white/50 mt-0.5">
                        {evidencePackId
                          ? (() => {
                              // PACK MODE: live truth from the durable queue —
                              // but "record gone = attached" ONLY for a photo
                              // PROVEN handed off this session (rev 8). Quiet
                              // retries read as Uploading; only an exhausted
                              // failure says so.
                              const rec = queueRecordById.get(p.id)
                              const status = packRowStatus(
                                batchIds.has(p.id),
                                rec
                                  ? { discardRequested: rec.discardRequested, exhausted: isExhausted(rec) }
                                  : undefined,
                                packQueue.hydrated,
                              )
                              if (status === 'not_attached') return 'Not attached yet'
                              if (status === 'pending') return '…'
                              if (status === 'attached') return 'Attached'
                              if (status === 'removing') return 'Removing…'
                              if (status === 'failed') return 'Could not upload'
                              return 'Uploading…'
                            })()
                          : p.state === 'uploading'
                            ? 'Uploading…'
                            : p.state === 'uploaded'
                              ? 'Attached'
                              : p.state === 'error'
                                ? p.error
                                : '…'}
                      </p>
                    </div>
                    {evidencePackId ? (
                      (() => {
                        const rec = queueRecordById.get(p.id)
                        const status = packRowStatus(
                          batchIds.has(p.id),
                          rec
                            ? { discardRequested: rec.discardRequested, exhausted: isExhausted(rec) }
                            : undefined,
                          packQueue.hydrated,
                        )
                        if (status === 'not_attached')
                          return <span className="text-red-400 text-xs">!</span>
                        if (status === 'pending') return null
                        if (status === 'attached')
                          return <span className="text-emerald-400 text-xs">✓</span>
                        if (status === 'failed')
                          return <span className="text-red-400 text-xs">!</span>
                        if (status === 'removing') return null
                        return (
                          <Loader2
                            size={16}
                            className="animate-spin text-white/60"
                            aria-hidden
                          />
                        )
                      })()
                    ) : p.state === 'uploading' ? (
                      <Loader2 size={16} className="animate-spin text-white/60" aria-hidden />
                    ) : p.state === 'uploaded' ? (
                      <span className="text-emerald-400 text-xs">✓</span>
                    ) : p.state === 'error' ? (
                      <span className="text-red-400 text-xs">!</span>
                    ) : null}
                  </li>
                ))}
              </ul>

              {stage === 'done' && evidencePackId ? (
                // PACK MODE — the honest contract. Done means every retained
                // batch photo is server-attached with its caption. Never
                // "queued", never "saved on this device". One calm progress
                // line; ONE concise failure state only after retries are
                // truly exhausted.
                <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
                  {batchError ? (
                    <p className="w-full text-xs text-amber-400">{batchError}</p>
                  ) : null}
                  {batch.exhausted > 0 ? (
                    <p className="text-sm text-red-400 mr-auto">
                      {batch.exhausted} photo{batch.exhausted === 1 ? '' : 's'} could not
                      upload.
                    </p>
                  ) : batch.complete ? (
                    <p className="text-sm text-emerald-400 mr-auto">
                      {batch.total} photo{batch.total === 1 ? '' : 's'} attached
                    </p>
                  ) : (
                    // Unique persisted photo ids — this number can only fall.
                    // Claims, retries, refreshes and reclassification never
                    // change how many RECORDS remain.
                    <p className="text-sm text-white/70 mr-auto">
                      {batch.outstanding} photo{batch.outstanding === 1 ? '' : 's'} left to
                      attach… Safe to switch apps — upload resumes when you return.
                    </p>
                  )}
                  {batch.exhausted > 0 ? (
                    <button
                      type="button"
                      onClick={() => void retryQueueFailed(evidencePackId)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 active:bg-amber-500 transition"
                    >
                      Try again
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={finishAndReload}
                      disabled={!batch.complete}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed active:bg-emerald-600 transition"
                    >
                      {batch.complete ? 'Done' : 'Uploading…'}
                    </button>
                  )}
                </div>
              ) : stage === 'done' ? (
                <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
                  {errorCount > 0 ? (
                    <p className="text-sm text-red-400 mr-auto">
                      {errorCount} photo{errorCount === 1 ? '' : 's'} failed to save — retry,
                      or discard to submit only what saved.
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
