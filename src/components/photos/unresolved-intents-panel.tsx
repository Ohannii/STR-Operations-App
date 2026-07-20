'use client'

import { AlertTriangle, RotateCcw } from 'lucide-react'
import {
  discardPrearrivalPhotoIntentAction,
  recoverPrearrivalPhotoIntentAction,
} from '@/app/properties/[id]/packs/actions'

export type UnresolvedIntent = {
  id: string
  createdAt: string | null
}

/**
 * Unresolved pre-arrival upload intents — photos the server was PROMISED but
 * never received. This is server truth, so it survives reloads, other tabs and
 * other devices.
 *
 * The pack cannot be submitted while any of these exist. The inspector has
 * exactly two honest routes:
 *   1. Recapture the photo (preferred) — the pack then completes normally.
 *   2. Deliberately exclude it, with a REQUIRED written reason, recorded
 *      against their user id and timestamp by the RPC.
 * There is no silent "submit what saved" escape, and nothing here deletes
 * evidence — a completed photo can never be discarded through this path.
 */
export function UnresolvedIntentsPanel({
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
