'use client'

/**
 * GalleryUploader — bulletproof mobile-friendly upload path.
 *
 * Why this exists alongside EvidenceCapture:
 *   - EvidenceCapture opens a modal and (in camera mode) calls
 *     getUserMedia. On phones over LAN HTTP, denied permissions,
 *     or quirky browsers, that whole flow can silently fail.
 *   - Auto-triggering a file picker from useEffect is BLOCKED by
 *     iOS Safari — file picker opens must come from a direct
 *     user gesture, not a programmatic click.
 *
 * What this does instead:
 *   - Renders a styled <label> wrapping a plain <input type="file"
 *     accept="image/*" multiple>. Tapping the label IS the user
 *     gesture that opens the native file picker. No JavaScript
 *     between tap and picker. Works on every browser that has a
 *     working <input type=file> (i.e. all of them).
 *   - On change, runs the same compress + sign + PUT + attach
 *     pipeline as EvidenceCapture, with bounded concurrency.
 *
 * Diagnostic surface (post-rewrite for the iPhone "photos don't
 * attach" report):
 *   - Per-file status row: Compressing / Uploading / Done / Error
 *   - Errors include the exact reason returned by the server
 *     action or the storage PUT response code
 *   - NO auto window.location.reload() — iOS Safari aggressively
 *     caches GETs and may serve a stale dashboard back. Instead
 *     we call Next's router.refresh() to invalidate the RSC cache
 *     in place, AND surface a deliberate "Refresh apartment"
 *     button so the user has explicit confirmation.
 *   - Files are captured into a plain array BEFORE the input is
 *     reset, so iOS's "FileList is live" quirk can't drop them.
 *
 * Trade-off: no thumb-strip preview, no per-photo caption editor
 * in the upload flow itself. The Pack Report page is the editor
 * surface (it already supports per-photo caption editing on draft
 * packs), so users add captions there if they need them.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Smartphone,
  XCircle,
} from 'lucide-react'
import { compressForEvidence } from '@/lib/photos/compress'
import { packCapture } from '@/lib/photos/pack-capture-store'
import { drainQueue, enqueuePhoto } from '@/lib/photos/photo-queue'
import { packScopeError } from '@/lib/photos/photo-queue-state'
import {
  attachEvidencePhoto,
  requestPhotoUploadSlot,
  type UploadSlot,
} from '@/app/properties/[id]/photos/actions'

type Props = {
  propertyId: string
  flagId?: string | null
  evidencePackId?: string | null
  label?: string
  /** When true, also adds capture="environment" hint to open the
   *  device camera straight from the picker on supporting phones. */
  preferCamera?: boolean
  /**
   * Outcome 3: required for PRE-ARRIVAL PACK uploads so each photo is written
   * to the app-private durable queue, scoped to this user/company. Omitted for
   * flag capture, which keeps its original in-memory pipeline.
   */
  userId?: string
  companyId?: string
}

type FileStatus =
  | 'compressing'
  | 'signing'
  | 'uploading'
  | 'attaching'
  /**
   * PRE-ARRIVAL ONLY: the compressed blobs are safely in the app-private
   * device queue, but the server has NOT confirmed attachment. This must
   * never be presented as "attached" — the sequential worker and
   * PackQueuePanel own the rest of the journey.
   */
  | 'device_saved'
  /** Server-confirmed attach (flag path only). */
  | 'done'
  | 'error'

type PerFile = {
  id: string
  name: string
  size: number
  status: FileStatus
  error?: string
  /** Kept in memory so a failed upload can be retried (never persisted). */
  file?: File
  // Idempotent-retry state — all reused across attempts so a retry targets
  // the SAME photo id / paths and never duplicates a row or object.
  slot?: UploadSlot
  master?: Blob
  thumb?: Blob
  width?: number
  height?: number
  sizeBytes?: number
  masterDone?: boolean
  thumbDone?: boolean
}

/**
 * Client-side LOGICAL PHOTO ID — a real v4 UUID, reused across retries, which
 * becomes the primary key of the durable server-side upload intent.
 */
function clientId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function GalleryUploader({
  propertyId,
  flagId,
  evidencePackId,
  label,
  preferCamera = false,
  userId,
  companyId,
}: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [items, setItems] = useState<PerFile[]>([])
  const [busy, setBusy] = useState(false)
  // Mirror of `items` for reads inside the async worker (state is stale in
  // closures). Lets a retry reuse a row's stored slot / compressed blobs.
  const itemsRef = useRef<PerFile[]>([])
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const updateItem = useCallback(
    (id: string, patch: Partial<PerFile>) => {
      setItems((prev) => {
        const next = prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
        itemsRef.current = next
        return next
      })
    },
    [],
  )

  // Upload one row by id, reading the LATEST row from itemsRef so a retry
  // reuses the row's stored compressed blobs + upload slot + PUT progress.
  // This makes retry idempotent: the same photo id/paths are targeted, a
  // Storage 409 (create-only) counts as already-uploaded, and the server
  // attach treats a PK conflict as success — so a lost response can never
  // duplicate a row or object.
  const processRow = useCallback(
    async (rowId: string): Promise<boolean> => {
      const current = () => itemsRef.current.find((r) => r.id === rowId)
      try {
        const row = current()
        if (!row || !row.file) throw new Error('Nothing to upload for this file.')

        let { master, thumb, width, height, sizeBytes } = row
        if (!master || !thumb) {
          updateItem(rowId, { status: 'compressing' })
          const c = await compressForEvidence(row.file)
          master = c.master
          thumb = c.thumb
          width = c.width
          height = c.height
          sizeBytes = c.sizeBytes
          updateItem(rowId, { master, thumb, width, height, sizeBytes })
        }

        let slot = current()?.slot
        if (!slot) {
          updateItem(rowId, { status: 'signing' })
          const requested = (await requestPhotoUploadSlot({
            propertyId,
            flagId: flagId ?? null,
            evidencePackId: evidencePackId ?? null,
            // Stable logical id → idempotent intent + slot across retries.
            photoId: rowId,
          })) as UploadSlot | { ok: false; error: string }
          if (!requested.ok) throw new Error(`Could not get upload slot: ${requested.error}`)
          slot = requested
          updateItem(rowId, { slot })
        }

        updateItem(rowId, { status: 'uploading' })
        if (evidencePackId) packCapture.mark(evidencePackId, rowId, 'uploading')
        // Create-only duplicates CONVERGE (P0, 22 Jul night): 409, a 400
        // whose body says already-exists, or a NULL upload (server verified
        // the object exists) all mean the bytes are safe — done, not fatal.
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
            let detail = ''
            try {
              const body = await res.text()
              if (/already exists|duplicate/i.test(body)) return
              detail = body ? `: ${body.slice(0, 200)}` : ''
            } catch {
              /* ignore */
            }
            throw new Error(`Storage PUT failed (${res.status})${detail}`)
          }
        }
        await putOnce(slot.masterUpload, master as Blob, !!current()?.masterDone)
        updateItem(rowId, { masterDone: true })
        await putOnce(slot.thumbUpload, thumb as Blob, !!current()?.thumbDone)
        updateItem(rowId, { thumbDone: true })

        updateItem(rowId, { status: 'attaching' })
        if (evidencePackId) packCapture.mark(evidencePackId, rowId, 'attaching')
        const attached = await attachEvidencePhoto({
          photoId: slot.photoId,
          propertyId,
          flagId: flagId ?? null,
          evidencePackId: slot.evidencePackId,
          masterPath: slot.masterPath,
          thumbPath: slot.thumbPath,
          width: width ?? 0,
          height: height ?? 0,
          sizeBytes: sizeBytes ?? 0,
          capturedAt: row.file.lastModified
            ? new Date(row.file.lastModified).toISOString()
            : new Date().toISOString(),
          note: null,
          retentionClass: slot.retentionClass,
        })
        if (!attached.ok) throw new Error(`Attach failed: ${attached.error}`)

        updateItem(rowId, { status: 'done' })
        if (evidencePackId) packCapture.mark(evidencePackId, rowId, 'saved')
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown upload error.'
        console.error('[GalleryUploader] upload error:', msg, err)
        updateItem(rowId, { status: 'error', error: msg })
        if (evidencePackId) packCapture.mark(evidencePackId, rowId, 'failed')
        return false
      }
    },
    [propertyId, flagId, evidencePackId, updateItem],
  )

  const runPool = useCallback(async (ids: string[]) => {
    const UPLOAD_CONCURRENCY = 4
    const queue = [...ids]
    const worker = async () => {
      while (true) {
        const id = queue.shift()
        if (!id) return
        await processRow(id)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker),
    )
  }, [processRow])

  const handleFiles = useCallback(
    async (files: File[]) => {
      // Only image files get a file (and thus become processable/retriable);
      // everything else surfaces as an explicit, non-retriable skip.
      const rows: PerFile[] = files.map((f) => {
        const isImg = f.type.startsWith('image/')
        return {
          id: clientId(),
          name: f.name || 'photo',
          size: f.size,
          status: isImg ? 'compressing' : 'error',
          error: isImg ? undefined : 'Not an image file — skipped.',
          file: isImg ? f : undefined,
        }
      })
      setItems(rows)
      itemsRef.current = rows
      setBusy(true)

      const processable = rows.filter((r) => r.file)

      // PRE-ARRIVAL PACK (Outcome 3): compress, then persist BOTH blobs to the
      // app-private device queue BEFORE any network work. Selecting from the
      // gallery is already an explicit "upload these" action, so records are
      // released immediately and the sequential worker takes over — it
      // survives reloads, calls and process kills. Flag capture keeps the
      // original in-memory pipeline below, unchanged.
      if (evidencePackId) {
        const scopeError = packScopeError({
          userId,
          companyId,
          propertyId,
          packId: evidencePackId,
        })
        if (scopeError) {
          for (const r of processable) {
            updateItem(r.id, { status: 'error', error: scopeError })
          }
          setBusy(false)
          return
        }

        for (const r of processable) {
          try {
            updateItem(r.id, { status: 'compressing' })
            const c = await compressForEvidence(r.file as File)
            await enqueuePhoto(
              { userId: userId!, companyId: companyId!, propertyId, packId: evidencePackId },
              {
                id: r.id,
                master: c.master,
                thumb: c.thumb,
                width: c.width,
                height: c.height,
                sizeBytes: c.sizeBytes,
                capturedAt: (r.file as File).lastModified
                  ? new Date((r.file as File).lastModified).toISOString()
                  : new Date().toISOString(),
                note: null,
                release: true,
              },
            )
            // The bytes are now durable ON THIS DEVICE — nothing more. The
            // server has not seen this photo yet, so it must NOT be shown as
            // attached. PackQueuePanel is authoritative from here.
            packCapture.commit(evidencePackId, r.id)
            updateItem(r.id, { status: 'device_saved' })
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : 'This photo could not be saved on your device.'
            updateItem(r.id, { status: 'error', error: msg })
          }
        }
        void drainQueue(evidencePackId)
        setBusy(false)
        router.refresh()
        return
      }

      await runPool(processable.map((r) => r.id))

      setBusy(false)
      // Refresh the RSC payload in place (no full reload — iOS Safari may
      // serve a cached GET and hide new photos). Client state is preserved.
      router.refresh()
    },
    // userId/companyId/propertyId are read inside the pre-arrival queue path
    // and updateItem is called per row — all must be dependencies or a stale
    // closure could enqueue a photo against the WRONG scope (or write to a
    // stale row), which is exactly the class of bug this queue exists to stop.
    [evidencePackId, userId, companyId, propertyId, updateItem, runPool, router],
  )

  // Retry only the failed uploads, REUSING each row's stored slot + blobs
  // (idempotent). Their File blobs live only in memory, so this recovers a
  // failed save instead of losing it.
  const retryFailed = useCallback(async () => {
    const failed = itemsRef.current.filter((r) => r.status === 'error' && r.file)
    if (failed.length === 0) return
    setBusy(true)
    if (evidencePackId) {
      for (const r of failed) packCapture.mark(evidencePackId, r.id, 'uploading')
    }
    for (const r of failed) updateItem(r.id, { status: 'compressing', error: undefined })
    await runPool(failed.map((r) => r.id))
    setBusy(false)
    router.refresh()
  }, [evidencePackId, runPool, updateItem, router])

  const isMisconfigured = !flagId && !evidencePackId

  const buttonLabel = label ?? 'Upload from gallery'
  // Server-confirmed attaches ONLY (flag path). A pre-arrival photo sitting in
  // the device queue is deliberately excluded — it is not attached yet.
  const successCount = items.filter((i) => i.status === 'done').length
  const deviceSavedCount = items.filter((i) => i.status === 'device_saved').length
  const errorCount = items.filter((i) => i.status === 'error').length

  // Warn before leaving/reloading while an upload is in flight or a
  // failed file still needs a retry — the compressed bytes live only in
  // memory and would be lost silently otherwise.
  const hasUnsavedWork = busy || errorCount > 0
  useEffect(() => {
    if (!hasUnsavedWork) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsavedWork])

  return (
    <div className="inline-flex flex-col gap-2 min-w-0">
      <label
        className={
          isMisconfigured || busy
            ? 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-400 cursor-not-allowed'
            : 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition'
        }
        title={
          isMisconfigured
            ? 'Start a pack first to upload photos here.'
            : undefined
        }
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" aria-hidden />
        ) : (
          <ImageIcon size={14} aria-hidden />
        )}
        <span>
          {busy
            ? `Uploading ${successCount + errorCount}/${items.length}…`
            : buttonLabel}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          {...(preferCamera ? { capture: 'environment' as const } : {})}
          className="hidden"
          disabled={isMisconfigured || busy}
          onChange={(e) => {
            // Capture into a plain array BEFORE iOS Safari has a
            // chance to invalidate the live FileList. Resetting
            // `e.target.value` immediately is required to allow
            // re-selecting the same files later — but only AFTER
            // we have our own array.
            const input = e.currentTarget
            const arr: File[] = input.files ? Array.from(input.files) : []
            input.value = ''
            if (arr.length > 0) {
              void handleFiles(arr)
            }
          }}
        />
      </label>

      {/* Per-file status list. Stays visible after upload completes
          so the user can SEE what happened — no auto-reload that
          erases the result. max-w-full on small screens prevents
          the panel pushing the page wider than the viewport. */}
      {items.length > 0 ? (
        <div className="rounded-md border border-slate-200 bg-white p-2 w-full max-w-full sm:max-w-md">
          <ul className="space-y-1 text-xs">
            {items.map((it) => (
              <li key={it.id} className="flex items-start gap-2">
                <div className="shrink-0 mt-0.5">
                  {it.status === 'done' ? (
                    <CheckCircle2
                      size={13}
                      className="text-emerald-600"
                      aria-hidden
                    />
                  ) : it.status === 'device_saved' ? (
                    <Smartphone size={13} className="text-amber-600" aria-hidden />
                  ) : it.status === 'error' ? (
                    <XCircle size={13} className="text-red-600" aria-hidden />
                  ) : (
                    <Loader2
                      size={13}
                      className="text-slate-500 animate-spin"
                      aria-hidden
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-slate-700">
                    <span className="font-medium">{it.name}</span>
                    <span className="text-slate-400"> · {fmtSize(it.size)}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {it.status === 'done'
                      ? 'Attached to the pack.'
                      : it.status === 'device_saved'
                        ? 'Saved on this device — uploading…'
                        : it.status === 'error'
                          ? (it.error ?? 'Failed.')
                          : it.status === 'compressing'
                            ? 'Compressing on device…'
                            : it.status === 'signing'
                              ? 'Asking server for upload slot…'
                              : it.status === 'uploading'
                                ? 'Uploading to storage…'
                                : 'Attaching to pack…'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {!busy ? (
            <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
              <p
                className={
                  errorCount > 0
                    ? 'text-red-600 font-medium'
                    : deviceSavedCount > 0
                      ? 'text-amber-700 font-medium'
                      : 'text-emerald-700 font-medium'
                }
              >
                {/* Never claim "attached" for device-queued photos. */}
                {deviceSavedCount > 0
                  ? `${deviceSavedCount} saved on this device · ${errorCount} failed`
                  : `${successCount} attached · ${errorCount} failed`}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Destructive: clearing failed rows discards them. It
                    // releases them from the intent map (so they stop
                    // blocking) but does NOT lower the pack's target — the
                    // inspector must still retry or recapture. Confirm first,
                    // and never imply they were saved.
                    if (errorCount > 0) {
                      const ok =
                        typeof window === 'undefined' ||
                        window.confirm(
                          `${errorCount} photo${errorCount === 1 ? '' : 's'} did NOT save and ` +
                            `will be discarded. They were not added to the pack. Clear anyway?`,
                        )
                      if (!ok) return
                    }
                    if (evidencePackId) {
                      for (const it of itemsRef.current) {
                        if (it.status === 'error') packCapture.remove(evidencePackId, it.id)
                      }
                    }
                    setItems([])
                  }}
                  className="text-slate-500 hover:text-slate-700 transition"
                >
                  Clear
                </button>
                {errorCount > 0 ? (
                  <button
                    type="button"
                    onClick={retryFailed}
                    className="rounded bg-amber-500 text-white px-2 py-1 font-medium hover:bg-amber-600 transition"
                  >
                    Retry {errorCount} failed
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => router.refresh()}
                  className="rounded bg-slate-900 text-white px-2 py-1 font-medium hover:bg-slate-800 transition"
                >
                  Refresh apartment
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
