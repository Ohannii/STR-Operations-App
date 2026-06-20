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

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  XCircle,
} from 'lucide-react'
import { compressForEvidence } from '@/lib/photos/compress'
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
}

type FileStatus =
  | 'compressing'
  | 'signing'
  | 'uploading'
  | 'attaching'
  | 'done'
  | 'error'

type PerFile = {
  id: string
  name: string
  size: number
  status: FileStatus
  error?: string
}

function clientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
}: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [items, setItems] = useState<PerFile[]>([])
  const [busy, setBusy] = useState(false)

  const updateItem = useCallback(
    (id: string, patch: Partial<PerFile>) => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
    },
    [],
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      // Pre-filter: only images. Surface a row for everything else
      // so the user sees the skip explicitly.
      const all: PerFile[] = files.map((f) => ({
        id: clientId(),
        name: f.name || 'photo',
        size: f.size,
        status: 'compressing',
        ...(f.type.startsWith('image/')
          ? {}
          : { status: 'error' as FileStatus, error: 'Not an image file — skipped.' }),
      }))
      setItems(all)
      setBusy(true)

      const queue = files.map((f, i) => ({ file: f, row: all[i] }))
        .filter((p) => p.row.status === 'compressing')

      const uploadOne = async (file: File, row: PerFile): Promise<boolean> => {
        try {
          updateItem(row.id, { status: 'compressing' })
          const compressed = await compressForEvidence(file)

          updateItem(row.id, { status: 'signing' })
          const slot = (await requestPhotoUploadSlot({
            propertyId,
            flagId: flagId ?? null,
            evidencePackId: evidencePackId ?? null,
          })) as UploadSlot | { ok: false; error: string }
          if (!slot.ok) {
            throw new Error(`Could not get upload slot: ${slot.error}`)
          }

          updateItem(row.id, { status: 'uploading' })
          const put = async (signedUrl: string, blob: Blob) => {
            const res = await fetch(signedUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'image/jpeg' },
              body: blob,
            })
            if (!res.ok) {
              // Pull the body text for the diagnostic — Supabase
              // returns a JSON error with a `message` field on
              // most failures.
              let detail = ''
              try {
                const body = await res.text()
                detail = body ? `: ${body.slice(0, 200)}` : ''
              } catch {
                /* ignore */
              }
              throw new Error(`Storage PUT failed (${res.status})${detail}`)
            }
          }
          await Promise.all([
            put(slot.masterUpload.signedUrl, compressed.master),
            put(slot.thumbUpload.signedUrl, compressed.thumb),
          ])

          updateItem(row.id, { status: 'attaching' })
          const attached = await attachEvidencePhoto({
            photoId: slot.photoId,
            propertyId,
            flagId: flagId ?? null,
            evidencePackId: slot.evidencePackId,
            masterPath: slot.masterPath,
            thumbPath: slot.thumbPath,
            width: compressed.width,
            height: compressed.height,
            sizeBytes: compressed.sizeBytes,
            capturedAt: file.lastModified
              ? new Date(file.lastModified).toISOString()
              : new Date().toISOString(),
            note: null,
            retentionClass: slot.retentionClass,
          })
          if (!attached.ok) {
            throw new Error(`Attach failed: ${attached.error}`)
          }

          updateItem(row.id, { status: 'done' })
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown upload error.'
          console.error('[GalleryUploader] upload error:', msg, err)
          updateItem(row.id, { status: 'error', error: msg })
          return false
        }
      }

      // Worker pool. Concurrency 4 — sequential is too slow for
      // 10+ photo batches, full parallel saturates mobile radios.
      // Bumped to 4 alongside the smaller compressed file size.
      const UPLOAD_CONCURRENCY = 4
      const workQueue = [...queue]
      const worker = async () => {
        while (true) {
          const next = workQueue.shift()
          if (!next) return
          await uploadOne(next.file, next.row)
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, workQueue.length) },
          worker,
        ),
      )

      setBusy(false)
      // Invalidate the RSC cache in place — does NOT do a full
      // window.location.reload() (which iOS Safari may serve from
      // its disk cache, hiding new photos). router.refresh() asks
      // the server for fresh data and re-streams the components
      // while preserving any client state we want to keep visible
      // (the per-file status list above).
      router.refresh()
    },
    [propertyId, flagId, evidencePackId, updateItem, router],
  )

  const isMisconfigured = !flagId && !evidencePackId

  const buttonLabel = label ?? 'Upload from gallery'
  const successCount = items.filter((i) => i.status === 'done').length
  const errorCount = items.filter((i) => i.status === 'error').length

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
                    : 'text-emerald-700 font-medium'
                }
              >
                {successCount} attached · {errorCount} failed
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setItems([])
                  }}
                  className="text-slate-500 hover:text-slate-700 transition"
                >
                  Clear
                </button>
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
