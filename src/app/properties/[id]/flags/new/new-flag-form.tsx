'use client'

/**
 * NewFlagForm — Slice 11B-2 photo-enabled new-flag capture (client).
 *
 * Replaces the old server-action form for the FIELD flow: photos are
 * mandatory (1..5), so the flag is created via finalizeFlagWithPhotos
 * (transactional flag + photos) — NOT the old createFlagAction, which
 * would create a flag with no photos.
 *
 * Flow per photo:
 *   compress (existing compressForEvidence) → requestFlagPhotoUploadSlot
 *   → PUT only the master/thumb URLs returned (partial-retry aware;
 *   already_uploaded uploads nothing) → mark Uploaded.
 * Remove calls removeFlagPhotoObjects then drops the tile.
 *
 * All existing new-flag fields + validation are preserved; only the
 * submit path and the photo controls are new.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Camera,
  CheckCircle2,
  ChevronDown,
  Images,
  Loader2,
  RotateCw,
  X,
  XCircle,
} from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Label } from '@/components/ui/input'
import { compressForEvidence } from '@/lib/photos/compress'
import { describeUploadFailure } from '@/lib/photos/upload-error'
import {
  requestFlagPhotoUploadSlot,
  removeFlagPhotoObjects,
} from '@/app/properties/[id]/photos/actions'
import { finalizeFlagWithPhotos } from './actions'

type CategoryOption = { key: string; label: string }
type AccountabilityOption = { value: string; label: string }

type Props = {
  propertyId: string
  categories: CategoryOption[]
  initialKey: string
  initialSeverity: 'low' | 'med' | 'high'
  accountabilityOptions: AccountabilityOption[]
  defaultAccountability: string
  cancelHref: string
}

const MAX_PHOTOS = 5

type PhotoStatus = 'compressing' | 'uploading' | 'uploaded' | 'failed'

type PhotoDescriptor = {
  photoId: string
  width: number
  height: number
  sizeBytes: number
}

type PhotoItem = {
  photoId: string
  file: File
  localUrl: string
  status: PhotoStatus
  error?: string
  descriptor?: PhotoDescriptor
  /** True while a removeFlagPhotoObjects call for this tile is in flight. */
  removing?: boolean
}

/**
 * RFC-4122 v4 UUID via crypto.getRandomValues, which is available in ALL
 * browser contexts — including non-secure LAN-http used for on-device
 * testing — unlike crypto.randomUUID (secure-context only). The backend
 * validates the format strictly, so this must always be a well-formed v4.
 */
function uuidv4(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}

async function putBlob(signedUrl: string, blob: Blob): Promise<void> {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  })
  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
    // describeUploadFailure returns a SAFE message (status + parsed storage
    // message only) — it never includes the signed URL or token.
    throw new Error(describeUploadFailure(res.status, body))
  }
}

export function NewFlagForm({
  propertyId,
  categories,
  initialKey,
  initialSeverity,
  accountabilityOptions,
  defaultAccountability,
  cancelHref,
}: Props) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement | null>(null)
  // The proposed flag UUID is generated ONCE when the form loads.
  const [proposedFlagId] = useState(() => uuidv4())
  const [photos, setPhotos] = useState<PhotoItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Keep a ref to the latest photos so the unmount cleanup can revoke
  // every object URL. Syncing the ref inside an effect (NOT during render)
  // satisfies react-hooks/refs — a ref must not be written during render.
  const photosRef = useRef<PhotoItem[]>([])
  useEffect(() => {
    photosRef.current = photos
  }, [photos])
  // Revoke object URLs ONLY on unmount (empty deps). This intentionally
  // does not run on every `photos` change, so a live preview is never
  // revoked mid-session.
  useEffect(() => {
    return () => {
      for (const p of photosRef.current) URL.revokeObjectURL(p.localUrl)
    }
  }, [])

  const patchPhoto = useCallback((photoId: string, patch: Partial<PhotoItem>) => {
    setPhotos((prev) =>
      prev.map((x) => (x.photoId === photoId ? { ...x, ...patch } : x)),
    )
  }, [])

  const processPhoto = useCallback(
    async (item: PhotoItem) => {
      const id = item.photoId
      try {
        patchPhoto(id, { status: 'compressing', error: undefined })
        const compressed = await compressForEvidence(item.file)

        patchPhoto(id, { status: 'uploading' })
        const slot = await requestFlagPhotoUploadSlot({
          propertyId,
          proposedFlagId,
          photoId: id,
        })
        if (!slot.ok) throw new Error(slot.error)

        if (slot.status === 'upload') {
          const puts: Promise<void>[] = []
          // Upload ONLY the URLs that were returned. A missing object
          // returns a URL; an already-present object returns null.
          if (slot.masterUpload) {
            puts.push(putBlob(slot.masterUpload.signedUrl, compressed.master))
          }
          if (slot.thumbUpload) {
            puts.push(putBlob(slot.thumbUpload.signedUrl, compressed.thumb))
          }
          await Promise.all(puts)
        }
        // status === 'already_uploaded' → both objects exist; nothing to PUT.

        patchPhoto(id, {
          status: 'uploaded',
          descriptor: {
            photoId: id,
            width: compressed.width,
            height: compressed.height,
            sizeBytes: compressed.sizeBytes,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed.'
        console.error('[NewFlagForm] photo error:', msg, err)
        patchPhoto(id, { status: 'failed', error: msg })
      }
    },
    [propertyId, proposedFlagId, patchPhoto],
  )

  const addFiles = useCallback(
    (files: File[]) => {
      setFormError(null)
      const images = files.filter((f) => f.type.startsWith('image/'))
      const remaining = MAX_PHOTOS - photos.length
      if (remaining <= 0) {
        setFormError(`You can attach at most ${MAX_PHOTOS} photos.`)
        return
      }
      const take = images.slice(0, remaining)
      if (images.length > remaining) {
        setFormError(
          `You can attach at most ${MAX_PHOTOS} photos — extra photos were skipped.`,
        )
      }
      const newItems: PhotoItem[] = take.map((f) => ({
        photoId: uuidv4(),
        file: f,
        localUrl: URL.createObjectURL(f),
        status: 'compressing',
      }))
      setPhotos((prev) => [...prev, ...newItems])
      for (const it of newItems) void processPhoto(it)
    },
    [photos.length, processPhoto],
  )

  const retryPhoto = useCallback(
    (item: PhotoItem) => {
      void processPhoto(item)
    },
    [processPhoto],
  )

  const removePhoto = useCallback(
    async (item: PhotoItem) => {
      if (item.removing) return // guard against double-remove
      // Storage-race guard: never remove while a master/thumb PUT is still
      // in flight. Deleting now would let the in-flight PUT re-create an
      // orphaned object AFTER the tile is gone. The Remove control is also
      // disabled in these states; this is belt-and-braces.
      if (item.status === 'compressing' || item.status === 'uploading') return
      // Mark in-flight so submit is blocked and the button disables while
      // the pre-finalisation bytes are deleted. Best-effort delete THEN
      // drop the tile; if the delete fails the orphan-cleanup rule covers
      // it — we never block the user on cleanup.
      patchPhoto(item.photoId, { removing: true })
      try {
        const res = await removeFlagPhotoObjects({
          propertyId,
          proposedFlagId,
          photoId: item.photoId,
        })
        if (!res.ok) {
          console.error('[NewFlagForm] removeFlagPhotoObjects:', res.error)
        }
      } catch (err) {
        console.error('[NewFlagForm] removeFlagPhotoObjects threw:', err)
      }
      URL.revokeObjectURL(item.localUrl)
      setPhotos((prev) => prev.filter((x) => x.photoId !== item.photoId))
    },
    [propertyId, proposedFlagId, patchPhoto],
  )

  const uploadedCount = photos.filter((p) => p.status === 'uploaded').length
  const anyInFlight = photos.some(
    (p) => p.status === 'compressing' || p.status === 'uploading',
  )
  const anyFailed = photos.some((p) => p.status === 'failed')
  const anyRemoving = photos.some((p) => p.removing)
  const canSubmit =
    !submitting &&
    !anyRemoving &&
    photos.length >= 1 &&
    photos.length <= MAX_PHOTOS &&
    uploadedCount === photos.length

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (submitting) return // prevent double submission
      setFormError(null)

      const form = formRef.current
      if (!form) return
      const fd = new FormData(form)
      const categoryKey = String(fd.get('category_key') ?? '').trim()
      const severity = String(fd.get('severity') ?? 'med').trim()
      const description = String(fd.get('description') ?? '').trim()
      const issueTitle = String(fd.get('issue_title') ?? '').trim()
      const accountability = String(fd.get('chargeable_party_decision') ?? '').trim()

      // Preserve existing field validation.
      const fail = (msg: string): void => {
        setFormError(msg)
      }
      if (!categoryKey) {
        fail('Pick an issue type.')
        return
      }
      if (!description) {
        fail('Description is required.')
        return
      }
      if (description.length > 1000) {
        fail('Description is too long (max 1000 characters).')
        return
      }

      // Photo gating (mandatory 1..5, all finished).
      if (photos.length < 1) {
        fail('Add at least one photo.')
        return
      }
      if (photos.length > MAX_PHOTOS) {
        fail(`Remove photos — the maximum is ${MAX_PHOTOS}.`)
        return
      }
      if (anyInFlight) {
        fail('Wait for all photos to finish uploading.')
        return
      }
      if (anyFailed) {
        fail('Retry or remove the failed photos before submitting.')
        return
      }
      if (anyRemoving) {
        fail('Wait for photo removal to finish.')
        return
      }

      const descriptors = photos
        .map((p) => p.descriptor)
        .filter((d): d is PhotoDescriptor => Boolean(d))
      if (descriptors.length !== photos.length) {
        fail('Some photos are not ready yet. Try again in a moment.')
        return
      }

      setSubmitting(true)
      try {
        const res = await finalizeFlagWithPhotos({
          propertyId,
          proposedFlagId,
          categoryKey,
          severity,
          description,
          issueTitle: issueTitle || null,
          accountability: accountability || null,
          photos: descriptors,
        })
        if (!res.ok) {
          setFormError(res.error)
          setSubmitting(false)
          return
        }
        // created OR already_finalized → go to the new flag.
        router.push(`/properties/${propertyId}/flags/${res.flagId}`)
        router.refresh()
        // Keep submitting=true; the route change unmounts this form.
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not report the issue.'
        console.error('[NewFlagForm] finalize error:', msg, err)
        setFormError(msg)
        setSubmitting(false)
      }
    },
    [
      submitting,
      photos,
      anyInFlight,
      anyFailed,
      anyRemoving,
      propertyId,
      proposedFlagId,
      router,
    ],
  )

  const inputCls =
    'block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900'

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-5">
      <Field
        label="Flag type"
        required
        htmlFor="category_key"
        hint="Pick the closest fit. Triage can re-classify later."
      >
        <div className="relative">
          <select
            id="category_key"
            name="category_key"
            defaultValue={initialKey}
            className="block w-full h-10 pl-3 pr-9 text-sm text-slate-900 appearance-none border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
        </div>
      </Field>

      <fieldset>
        <Label htmlFor="severity">
          Severity <span className="text-red-600 ml-0.5">*</span>
        </Label>
        <div className="flex gap-2">
          <SeverityChip value="low" label="Low" defaultChecked={initialSeverity === 'low'} />
          <SeverityChip value="med" label="Medium" defaultChecked={initialSeverity === 'med'} />
          <SeverityChip value="high" label="High" defaultChecked={initialSeverity === 'high'} />
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Default seeded from the flag type. Change if needed.
        </p>
      </fieldset>

      <Field
        label="Short title"
        htmlFor="issue_title"
        hint="Optional — a few words, e.g. &ldquo;Broken pot&rdquo;."
      >
        <input
          id="issue_title"
          name="issue_title"
          type="text"
          maxLength={80}
          placeholder="e.g. Broken pot"
          className={inputCls}
        />
      </Field>

      <Field
        label="Description"
        required
        htmlFor="description"
        hint="What did you notice? Plain language is fine."
      >
        <textarea
          id="description"
          name="description"
          required
          maxLength={1000}
          rows={4}
          placeholder="e.g. Cracked tile near bathroom door, about 10cm long. Looks recent."
          className={`${inputCls} resize-y min-h-[5rem]`}
        />
      </Field>

      <Field
        label="Who may be responsible?"
        htmlFor="chargeable_party_decision"
        hint="Optional — leave on “Not sure” if you can’t tell. A manager confirms this in triage."
      >
        <div className="relative">
          <select
            id="chargeable_party_decision"
            name="chargeable_party_decision"
            defaultValue={defaultAccountability}
            className="block w-full h-10 pl-3 pr-9 text-sm text-slate-900 appearance-none border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
          >
            {accountabilityOptions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
        </div>
      </Field>

      {/* ---- Photos (mandatory 1..5) ---- */}
      <fieldset className="space-y-3">
        <Label htmlFor="photos">
          Photos <span className="text-red-600 ml-0.5">*</span>
        </Label>
        <p className="-mt-1 text-xs text-slate-500">
          At least one photo is required (up to {MAX_PHOTOS}). Photos compress on
          your device before upload.
        </p>

        <div className="flex flex-wrap gap-2">
          <CaptureButton
            id="photo-camera"
            capture
            disabled={submitting || photos.length >= MAX_PHOTOS}
            onFiles={addFiles}
            icon={<Camera size={15} aria-hidden />}
            label="Take photo"
          />
          <CaptureButton
            id="photo-gallery"
            multiple
            disabled={submitting || photos.length >= MAX_PHOTOS}
            onFiles={addFiles}
            icon={<Images size={15} aria-hidden />}
            label="Choose from gallery"
          />
          <span className="self-center text-xs text-slate-500">
            {photos.length}/{MAX_PHOTOS} added
          </span>
        </div>

        {photos.length > 0 ? (
          <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
            {photos.map((p) => (
              <PhotoTile
                key={p.photoId}
                item={p}
                onRetry={() => retryPhoto(p)}
                onRemove={() => void removePhoto(p)}
              />
            ))}
          </ul>
        ) : null}
      </fieldset>

      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
        <Link href={cancelHref}>
          <Button variant="secondary" type="button" disabled={submitting}>
            Cancel
          </Button>
        </Link>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
          {submitting ? 'Reporting…' : 'Report issue'}
        </button>
      </div>
    </form>
  )
}

function CaptureButton({
  id,
  label,
  icon,
  onFiles,
  capture = false,
  multiple = false,
  disabled = false,
}: {
  id: string
  label: string
  icon: ReactNode
  onFiles: (files: File[]) => void
  capture?: boolean
  multiple?: boolean
  disabled?: boolean
}) {
  return (
    <label
      htmlFor={id}
      className={
        // focus-within: because the <input> is sr-only, keyboard focus
        // lands on the invisible input — surface a visible ring on the
        // label so keyboard users get clear focus indication.
        'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-slate-900 focus-within:ring-offset-2 ' +
        (disabled
          ? 'text-slate-400 cursor-not-allowed'
          : 'text-slate-700 hover:bg-slate-50 active:bg-slate-100 cursor-pointer')
      }
    >
      {icon}
      <span>{label}</span>
      <input
        id={id}
        type="file"
        accept="image/*"
        {...(capture ? { capture: 'environment' as const } : {})}
        {...(multiple ? { multiple: true } : {})}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const input = e.currentTarget
          const arr: File[] = input.files ? Array.from(input.files) : []
          input.value = '' // allow re-selecting the same file
          if (arr.length > 0) onFiles(arr)
        }}
      />
    </label>
  )
}

function PhotoTile({
  item,
  onRetry,
  onRemove,
}: {
  item: PhotoItem
  onRetry: () => void
  onRemove: () => void
}) {
  const busy = item.status === 'compressing' || item.status === 'uploading'
  const label =
    item.status === 'compressing'
      ? 'Compressing'
      : item.status === 'uploading'
        ? 'Uploading'
        : item.status === 'uploaded'
          ? 'Uploaded'
          : 'Failed'

  return (
    <li className="rounded-md border border-slate-200 overflow-hidden bg-slate-50">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.localUrl}
          alt="Selected evidence"
          className="w-full h-24 object-cover"
        />

        {/* Remove — allowed only when the photo is Uploaded or Failed.
            Disabled WHILE compressing/uploading so a delete can't race an
            in-flight PUT (which would re-create an orphaned object), and
            while its own delete is in flight. */}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy || item.removing}
          title={busy ? 'Wait for the photo to finish uploading' : 'Remove photo'}
          aria-label={
            busy ? 'Remove photo (available once the upload finishes)' : 'Remove photo'
          }
          className="absolute top-1 right-1 inline-flex items-center justify-center h-6 w-6 rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {item.removing ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <X size={13} aria-hidden />
          )}
        </button>

        <div
          className={
            'absolute inset-x-0 bottom-0 flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium text-white ' +
            (item.status === 'uploaded'
              ? 'bg-emerald-600/85'
              : item.status === 'failed'
                ? 'bg-red-600/85'
                : 'bg-slate-800/80')
          }
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : item.status === 'uploaded' ? (
            <CheckCircle2 size={12} aria-hidden />
          ) : (
            <XCircle size={12} aria-hidden />
          )}
          <span className="truncate">{label}</span>
          {item.status === 'failed' ? (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto inline-flex items-center gap-0.5 rounded bg-white/20 px-1.5 py-0.5 hover:bg-white/30 transition"
              title="Retry"
            >
              <RotateCw size={11} aria-hidden />
              Retry
            </button>
          ) : null}
        </div>
      </div>

      {/* Surface the actual (safe) failure reason beneath the tile so the
          user isn't left with only the word "Failed". */}
      {item.status === 'failed' && item.error ? (
        <p
          className="px-1.5 py-1 text-[10px] leading-tight text-red-600 break-words"
          title={item.error}
        >
          {item.error}
        </p>
      ) : null}
    </li>
  )
}

function SeverityChip({
  value,
  label,
  defaultChecked,
}: {
  value: 'low' | 'med' | 'high'
  label: string
  defaultChecked?: boolean
}) {
  return (
    <label className="cursor-pointer select-none">
      <input
        type="radio"
        name="severity"
        value={value}
        defaultChecked={defaultChecked}
        className="peer sr-only"
      />
      <span className="inline-block px-3.5 py-1.5 text-sm font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:border-slate-400 peer-checked:bg-slate-900 peer-checked:text-white peer-checked:border-slate-900 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900 peer-focus-visible:ring-offset-2 transition-colors">
        {label}
      </span>
    </label>
  )
}
