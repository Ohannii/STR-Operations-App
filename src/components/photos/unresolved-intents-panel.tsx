'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import {
  discardPrearrivalPhotoIntentAction,
  recoverPrearrivalPhotoIntentAction,
} from '@/app/properties/[id]/packs/actions'
import { usePackQueue } from '@/lib/photos/photo-queue'
import { filterTrueOrphans, ORPHAN_GRACE_MS } from '@/lib/photos/photo-queue-state'

export type UnresolvedIntent = {
  id: string
  createdAt: string | null
}

/**
 * TRUE-ORPHAN reconciliation. A pending server intent is only shown as
 * "never finished saving" when this device can positively say nobody owns it:
 *   * the local queue is HYDRATED (an unhydrated, empty-by-default snapshot
 *     proves nothing and must not accuse anyone);
 *   * no live local queue record carries the same stable photo uuid (a live
 *     record means the worker owns it: it is staging, uploading, retrying or
 *     being cleaned up — normal life, not abandonment);
 *   * the intent is older than a short grace period (cross-device case).
 *
 * WHY THIS EXISTS (live incident, 21 Jul 2026): upload-early staging creates
 * intents at CAPTURE, so every actively-uploading photo is briefly a pending
 * intent. The previous version showed every pending intent as an abandoned
 * photo with recover/exclude cards — 22 alarming cards on a 46-second-old
 * pack whose uploads were fine. This panel is CRASH RECOVERY, a last resort —
 * not the normal workflow's dominant surface.
 */
export function UnresolvedIntentsPanel({
  propertyId,
  packId,
  intents,
}: {
  propertyId: string
  packId: string
  intents: UnresolvedIntent[]
}) {
  const queue = usePackQueue(packId)

  // TIMER-DRIVEN timestamp: render stays pure (no Date.now() during render).
  // `now` is null until established, and while it is null — or before the
  // queue hydrates — NO orphan warning renders (accuse no one on missing
  // information). Timers re-establish it whenever inputs change and again at
  // the earliest moment a hidden-young intent crosses the grace threshold,
  // so a true orphan appears on time without any polling loop.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0)
    return () => clearTimeout(t)
  }, [intents, queue.hydrated, queue.records])

  useEffect(() => {
    if (now === null || !queue.hydrated) return
    const localIds = new Set(queue.records.map((r) => r.id))
    let nextCrossing: number | null = null
    for (const intent of intents) {
      if (localIds.has(intent.id) || !intent.createdAt) continue
      const crossesAt = new Date(intent.createdAt).getTime() + ORPHAN_GRACE_MS
      if (crossesAt > now && (nextCrossing === null || crossesAt < nextCrossing)) {
        nextCrossing = crossesAt
      }
    }
    if (nextCrossing === null) return
    const t = setTimeout(() => setNow(Date.now()), Math.max(250, nextCrossing - now + 50))
    return () => clearTimeout(t)
  }, [now, intents, queue.hydrated, queue.records])

  if (!queue.hydrated || now === null) return null

  // Reconciliation logic is PURE (filterTrueOrphans, unit-tested): requires
  // hydration, excludes worker-owned ids, applies the cross-device grace.
  const orphans = filterTrueOrphans(
    intents,
    new Set(queue.records.map((r) => r.id)),
    true,
    now,
  )

  return <OrphanCards propertyId={propertyId} intents={orphans} />
}

function OrphanCards({
  propertyId,
  intents,
}: {
  propertyId: string
  intents: UnresolvedIntent[]
}) {
  if (intents.length === 0) return null

  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-700" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-red-900">
            {intents.length} photo{intents.length === 1 ? '' : 's'} never finished saving
          </p>
          <p className="mt-0.5 text-xs text-red-800 leading-relaxed">
            These were started but never stored, so they are <strong>not</strong> part of
            the pack. Recapture {intents.length === 1 ? 'it' : 'them'} to complete the
            pack, or exclude {intents.length === 1 ? 'it' : 'them'} on purpose with a
            reason. This pack cannot be submitted until each one is resolved.
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {intents.map((intent, i) => (
          <li
            key={intent.id}
            className="rounded-md border border-red-200 bg-white p-2.5 min-w-0"
          >
            <p className="text-xs font-medium text-slate-800">
              Photo {i + 1}
              {intent.createdAt ? (
                <span className="font-normal text-slate-500">
                  {' '}
                  · started {new Date(intent.createdAt).toLocaleString()}
                </span>
              ) : null}
            </p>
            {/* Recovery FIRST: if the images already reached storage, the
                evidence is not lost and no revisit is needed. */}
            <form action={recoverPrearrivalPhotoIntentAction} className="mt-2">
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="photo_id" value={intent.id} />
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 sm:w-auto"
              >
                <RotateCcw size={13} aria-hidden />
                Try to recover this photo
              </button>
            </form>
            <p className="mt-1.5 text-[11px] text-slate-600">
              If recovery fails, the image never reached us — recapture it, or
              exclude it below with a reason.
            </p>

            <form
              action={discardPrearrivalPhotoIntentAction}
              onSubmit={(e) => {
                const ok =
                  typeof window === 'undefined' ||
                  window.confirm(
                    'Exclude this photo from the pack? It was NOT saved and cannot be recovered. ' +
                      'Your name, the time and your reason will be recorded.',
                  )
                if (!ok) e.preventDefault()
              }}
              className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="photo_id" value={intent.id} />
              <label htmlFor={`reason-${intent.id}`} className="sr-only">
                Reason for excluding this photo
              </label>
              <input
                id={`reason-${intent.id}`}
                name="reason"
                required
                maxLength={500}
                placeholder="Reason (required) — e.g. left site, cannot recapture"
                className="w-full min-w-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 sm:flex-1"
              />
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 sm:w-auto"
              >
                Exclude with reason
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
