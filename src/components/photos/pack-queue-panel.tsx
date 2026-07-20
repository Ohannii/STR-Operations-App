'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Smartphone, WifiOff } from 'lucide-react'
import { drainQueue, releaseQueued, retryFailed, usePackQueue } from '@/lib/photos/photo-queue'

/**
 * Device queue panel (Outcome 3).
 *
 * THE RECOVERY SURFACE. Photos captured before the inspector tapped "Attach"
 * live in app-private IndexedDB as `saved_local`. If a phone call or reload
 * destroys the React capture screen, those bytes are still on the device but
 * nothing else would reveal them — this panel is how they are found and
 * finished. It renders from IndexedDB, so it survives reloads, browser
 * restarts and process kills.
 *
 * Deliberate rules:
 *   * `saved_local` is NEVER auto-uploaded — the inspector must choose
 *     "Attach saved photos" (they may still be adding notes).
 *   * Once queued, uploads resume automatically (mount / pageshow /
 *     visibility / online) with no polling.
 *   * Nothing here deletes a record; only an authoritative server attach does.
 */
export function PackQueuePanel({ packId }: { packId: string }) {
  const { summary, online, storageError, describe } = usePackQueue(packId)
  const [busy, setBusy] = useState<null | 'attach' | 'retry'>(null)

  // Storage unreadable/unusable => fail closed, loudly.
  if (storageError) {
    return (
      <div
        role="alert"
        className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"
      >
        <p className="flex items-start gap-2 font-semibold">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          Photos cannot be stored safely on this device
        </p>
        <p className="mt-1 text-xs leading-relaxed">
          {storageError} Do not capture or submit this pack until this is fixed —
          reload the page, free up storage, or use a different browser.
        </p>
      </div>
    )
  }

  if (summary.total === 0) return null

  const inFlight = summary.uploading + summary.attaching
  const tone =
    summary.failed > 0
      ? 'border-red-200 bg-red-50 text-red-900'
      : !online
        ? 'border-slate-300 bg-slate-50 text-slate-800'
        : 'border-amber-200 bg-amber-50 text-amber-900'

  const Icon =
    summary.failed > 0
      ? AlertTriangle
      : !online
        ? WifiOff
        : inFlight > 0
          ? Loader2
          : Smartphone

  return (
    <div className={`mt-3 rounded-lg border p-3 ${tone}`} role="status" aria-live="polite">
      <p className="flex items-start gap-2 text-sm font-semibold">
        <Icon
          size={16}
          className={`mt-0.5 shrink-0 ${inFlight > 0 && summary.failed === 0 && online ? 'animate-spin' : ''}`}
          aria-hidden
        />
        {describe.text}
      </p>

      {summary.savedLocal > 0 ? (
        <p className="mt-1 text-xs leading-relaxed">
          {summary.savedLocal} photo{summary.savedLocal === 1 ? ' is' : 's are'} safely
          stored on this device but not attached to the pack yet. They survived any
          reload or interruption — attach them to finish.
        </p>
      ) : null}

      {!online && summary.total > 0 ? (
        <p className="mt-1 text-xs leading-relaxed">
          You are offline. These photos are safe on this device and will upload
          automatically when the connection returns.
        </p>
      ) : null}

      {inFlight > 0 ? (
        <p className="mt-1 text-xs leading-relaxed">
          Keep this page open until uploading finishes.
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
        {summary.savedLocal > 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('attach')
              try {
                await releaseQueued(packId)
                void drainQueue(packId)
              } finally {
                setBusy(null)
              }
            }}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 sm:w-auto"
          >
            <CheckCircle2 size={13} aria-hidden />
            {busy === 'attach'
              ? 'Attaching…'
              : `Attach ${summary.savedLocal} saved photo${summary.savedLocal === 1 ? '' : 's'}`}
          </button>
        ) : null}

        {summary.failed > 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('retry')
              try {
                await retryFailed(packId)
              } finally {
                setBusy(null)
              }
            }}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 sm:w-auto"
          >
            <RotateCcw size={13} aria-hidden />
            {busy === 'retry'
              ? 'Retrying…'
              : `Retry ${summary.failed} failed photo${summary.failed === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </div>
    </div>
  )
}
