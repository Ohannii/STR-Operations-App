'use client'

import { useEffect } from 'react'
import { AlertTriangle, Camera, Check, CheckCircle2, Loader2, Trash2 } from 'lucide-react'
import {
  discardEvidencePackAction,
  submitEvidencePackAction,
} from '@/app/properties/[id]/packs/actions'
import { packCapture, usePackCapture } from '@/lib/photos/pack-capture-store'
import { usePackQueue } from '@/lib/photos/photo-queue'
import {
  canSubmitPack,
  describePackStatus,
  shouldSuppressPackStatusBanner,
  type PackStatusTone,
} from '@/lib/photos/pack-status'

/**
 * Pre-arrival pack controls. Three pieces so the Action Centre can lay them
 * out with a clear hierarchy: ONE authoritative status, then "add photos",
 * then pack actions with Submit as the final primary, then the destructive
 * action separated.
 *
 * Authority note (Outcome 2): the AUTHORITATIVE state is server-side —
 * `serverUnresolvedCount` (pending upload intents) and `linkedPhotoCount`
 * (active photo rows) both come from the server and survive reloads, other
 * tabs and other devices. The client capture store only adds live in-flight
 * detail for the current session; the real gate is the finalise RPC.
 */

function useIntended(
  packId: string,
  linkedPhotoCount: number,
  serverUnresolved: number | null,
) {
  const { intendedTotal, blocking, pending, failed } = usePackCapture(packId)
  // Durable device queue (Outcome 3): photos whose bytes are safe on this
  // device but which the server has not confirmed yet.
  const queue = usePackQueue(packId)
  useEffect(() => {
    packCapture.syncBaseline(packId, linkedPhotoCount)
  }, [packId, linkedPhotoCount])
  const intended = Math.max(intendedTotal, linkedPhotoCount)
  // Blocked by: unknown server state (fail closed), the durable device queue,
  // server-side unresolved intents, or live in-session work.
  return {
    intended,
    blocking:
      blocking ||
      serverUnresolved === null ||
      serverUnresolved > 0 ||
      queue.summary.blocking ||
      queue.storageError !== null,
    pending,
    failed,
    queuedLocal: queue.summary.total,
    queueDescribe: queue.describe,
    storageError: queue.storageError,
  }
}

const BANNER_STYLE: Record<PackStatusTone, string> = {
  ready: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  uploading: 'bg-amber-50 border-amber-200 text-amber-900',
  failed: 'bg-red-50 border-red-200 text-red-900',
  empty: 'bg-slate-50 border-slate-200 text-slate-700',
  unknown: 'bg-slate-50 border-slate-300 text-slate-800',
}

/**
 * The ONE authoritative pack status. Prominent (not helper text) because an
 * inspector must be able to tell at a glance whether the evidence is safe.
 */
export function PackStatusBanner({
  packId,
  linkedPhotoCount,
  serverUnresolvedCount = 0,
  className,
}: {
  packId: string
  linkedPhotoCount: number
  serverUnresolvedCount?: number | null
  className?: string
}) {
  const { intended, pending, failed, queuedLocal, storageError } = useIntended(
    packId,
    linkedPhotoCount,
    serverUnresolvedCount,
  )

  // PackQueuePanel owns the message whenever the device queue has records or
  // storage is unusable — it is the surface with Retry / Attach. Rendering
  // here too showed the same failure twice. Submission stays blocked either
  // way: canSubmitPack is untouched by this purely visual suppression.
  if (shouldSuppressPackStatusBanner({ queuedLocal, hasStorageError: !!storageError })) {
    return null
  }

  const status = describePackStatus({
    linked: linkedPhotoCount,
    intended,
    pending,
    failed,
    serverUnresolved: serverUnresolvedCount,
    queuedLocal,
  })

  const Icon =
    status.tone === 'ready'
      ? CheckCircle2
      : status.tone === 'uploading'
        ? Loader2
        : status.tone === 'failed'
          ? AlertTriangle
          : Camera

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'flex items-center gap-2 rounded-lg border px-3 py-2 min-w-0',
        BANNER_STYLE[status.tone],
        className ?? '',
      ].join(' ')}
    >
      <Icon
        size={16}
        className={`shrink-0 ${status.tone === 'uploading' ? 'animate-spin' : ''}`}
        aria-hidden
      />
      <span className="text-sm font-medium leading-snug">{status.text}</span>
    </div>
  )
}

/**
 * The ONE guarded submit control. The server's finalise RPC is authoritative;
 * this button simply avoids sending a request that is certain to be rejected.
 * `showStatus` keeps the inline helper line for surfaces that don't render
 * the banner (e.g. the pack report page).
 */
export function PackSubmitButton({
  propertyId,
  packId,
  linkedPhotoCount,
  serverUnresolvedCount = 0,
  showStatus = true,
}: {
  propertyId: string
  packId: string
  /** Server-rendered count of active, non-deleted linked photos. */
  linkedPhotoCount: number
  /**
   * Server-side unresolved upload intents (authoritative, cross-device).
   * `null` = UNKNOWN (could not be read) → fail closed.
   */
  serverUnresolvedCount?: number | null
  showStatus?: boolean
}) {
  const { intended, blocking, pending, failed, queuedLocal } = useIntended(
    packId,
    linkedPhotoCount,
    serverUnresolvedCount,
  )
  const status = describePackStatus({
    linked: linkedPhotoCount,
    intended,
    pending,
    failed,
    serverUnresolved: serverUnresolvedCount,
    queuedLocal,
  })
  const canSubmit =
    !blocking &&
    canSubmitPack({
      linked: linkedPhotoCount,
      intended,
      pending,
      failed,
      serverUnresolved: serverUnresolvedCount,
      queuedLocal,
    })

  return (
    <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-start">
      <form action={submitEvidencePackAction} className="contents">
        <input type="hidden" name="property_id" value={propertyId} />
        <input type="hidden" name="pack_id" value={packId} />
        <input type="hidden" name="expected_count" value={String(intended)} />
        <button
          type="submit"
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
          title={canSubmit ? undefined : status.text}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 active:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 sm:w-auto"
        >
          <Check size={15} aria-hidden />
          {canSubmit ? `Submit pack (${linkedPhotoCount})` : 'Submit pack'}
        </button>
      </form>
      {showStatus ? (
        <span
          className={
            status.tone === 'ready'
              ? 'text-[11px] text-emerald-700'
              : status.tone === 'empty'
                ? 'text-[11px] text-slate-500'
                : 'text-[11px] text-amber-700'
          }
        >
          {status.text}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Discarding a draft is destructive and deliberately separated from the
 * normal actions — outlined danger styling plus an explicit confirm. It
 * never sits next to Submit.
 */
export function DiscardDraftButton({
  propertyId,
  packId,
}: {
  propertyId: string
  packId: string
}) {
  return (
    <form
      action={discardEvidencePackAction}
      onSubmit={(e) => {
        const ok =
          typeof window === 'undefined' ||
          window.confirm(
            'Discard this draft pre-arrival pack? It will not become a submitted record. This cannot be undone.',
          )
        if (!ok) e.preventDefault()
      }}
    >
      <input type="hidden" name="property_id" value={propertyId} />
      <input type="hidden" name="pack_id" value={packId} />
      <button
        type="submit"
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 sm:w-auto"
      >
        <Trash2 size={13} aria-hidden />
        Discard draft
      </button>
    </form>
  )
}
