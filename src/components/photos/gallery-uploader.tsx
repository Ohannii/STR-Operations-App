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
 *   - Shows progress + error state inline on the parent page.
 *     No modal. No camera. No getUserMedia.
 *
 * Trade-off: no thumb-strip preview, no per-photo caption editor
 * in the upload flow itself. The Pack Report page is the editor
 * surface (it already supports per-photo caption editing on draft
 * packs), so users add captions there if they need them.
 */

import { useCallback, useRef, useState } from 'react'
import { Image as ImageIcon, Loader2 } from 'lucide-react'
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

type ProgressState =
  | { kind: 'idle' }
  | { kind: 'working'; total: number; done: number; errors: number }
  | { kind: 'done'; total: number; errors: number }
  | { kind: 'error'; message: string }

export function GalleryUploader({
  propertyId,
  flagId,
  evidencePackId,
  label,
  preferCamera = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [progress, setProgress] = useState<ProgressState>({ kind: 'idle' })

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
      if (list.length === 0) {
        setProgress({
          kind: 'error',
          message: 'Choose image files (JPEG, PNG, or WebP).',
        })
        return
      }

      setProgress({ kind: 'working', total: list.length, done: 0, errors: 0 })

      // Upload one file with full pipeline: compress → sign → PUT → attach.
      const uploadOne = async (file: File): Promise<boolean> => {
        try {
          const compressed = await compressForEvidence(file)
          const slot = (await requestPhotoUploadSlot({
            propertyId,
            flagId: flagId ?? null,
            evidencePackId: evidencePackId ?? null,
          })) as UploadSlot | { ok: false; error: string }
          if (!slot.ok) throw new Error(slot.error)

          const put = async (signedUrl: string, blob: Blob) => {
            const res = await fetch(signedUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'image/jpeg' },
              body: blob,
            })
            if (!res.ok) throw new Error(`Upload failed (${res.status}).`)
          }
          await Promise.all([
            put(slot.masterUpload.signedUrl, compressed.master),
            put(slot.thumbUpload.signedUrl, compressed.thumb),
          ])

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
          if (!attached.ok) throw new Error(attached.error)
          return true
        } catch (err) {
          console.error('[GalleryUploader] upload error:', err)
          return false
        }
      }

      // Worker-pool concurrency 3 — same shape as EvidenceCapture.
      const UPLOAD_CONCURRENCY = 3
      const queue = [...list]
      let done = 0
      let errors = 0

      const worker = async () => {
        while (true) {
          const next = queue.shift()
          if (!next) return
          const ok = await uploadOne(next)
          if (ok) done++
          else errors++
          setProgress((prev) =>
            prev.kind === 'working'
              ? { kind: 'working', total: list.length, done, errors }
              : prev,
          )
        }
      }
      const workers = Array.from(
        { length: Math.min(UPLOAD_CONCURRENCY, queue.length) },
        worker,
      )
      await Promise.all(workers)

      setProgress({ kind: 'done', total: list.length, errors })

      // Refresh the page so the new photos appear in counts / grids.
      // window.location.reload() is fine — there's no in-flight state
      // we need to preserve.
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    },
    [propertyId, flagId, evidencePackId],
  )

  const isMisconfigured = !flagId && !evidencePackId
  const buttonLabel = label ?? 'Upload from gallery'

  return (
    <div className="inline-flex flex-col gap-1">
      <label
        className={
          isMisconfigured || progress.kind === 'working'
            ? 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-400 cursor-not-allowed'
            : 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition'
        }
        title={
          isMisconfigured
            ? 'Start a pack first to upload photos here.'
            : undefined
        }
      >
        {progress.kind === 'working' ? (
          <Loader2 size={14} className="animate-spin" aria-hidden />
        ) : (
          <ImageIcon size={14} aria-hidden />
        )}
        <span>
          {progress.kind === 'working'
            ? `Uploading ${progress.done}/${progress.total}…`
            : buttonLabel}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          {...(preferCamera ? { capture: 'environment' as const } : {})}
          className="hidden"
          disabled={isMisconfigured || progress.kind === 'working'}
          onChange={(e) => {
            void handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </label>
      {progress.kind === 'error' ? (
        <p className="text-xs text-red-600">{progress.message}</p>
      ) : null}
      {progress.kind === 'done' && progress.errors > 0 ? (
        <p className="text-xs text-red-600">
          {progress.errors} of {progress.total} photo
          {progress.total === 1 ? '' : 's'} failed to attach.
        </p>
      ) : null}
    </div>
  )
}
