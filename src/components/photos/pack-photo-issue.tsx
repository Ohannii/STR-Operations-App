'use client'

import { useEffect, useState, type ComponentType } from 'react'
import Link from 'next/link'
import { Check, Flag } from 'lucide-react'
import { usePackPhotoCaption } from '@/components/photos/pack-caption-editor'
import { ASANA_STATUS_LABEL, type AsanaIssueStatus } from '@/lib/issues/asana-status'
import {
  ASANA_STATUS_MAX_POLLS,
  isAsanaStatusPending,
  mergeIssueStatuses,
  nextAsanaStatusPollDelayMs,
  parseStatusResponse,
} from '@/lib/issues/asana-status-poll'

/**
 * "Report issue" for ONE photo of a DRAFT pre-arrival pack.
 *
 * LIGHT by design: on page load each photo renders only this button (and
 * any issues already saved from it). The sheet — its form, its thumbnail
 * and its code — is loaded and mounted the first time the reporter opens it.
 *
 *   - Cancel keeps the sheet mounted (hidden), so entries are still there
 *     on reopening.
 *   - A confirmed save unmounts it (key bump): entries are cleared and the
 *     next issue from this photo starts fresh, with new ids.
 *
 * The sheet opens over the pack (native <dialog>), so the pack, its
 * captions and the scroll position stay exactly where they were.
 */

type SheetComponent = ComponentType<
  import('@/components/photos/pack-photo-issue-sheet').PackPhotoIssueSheetProps
>

/**
 * The sheet's code, loaded on first use and shared by every photo on the
 * page. A failed load (e.g. no signal) is NOT cached and never throws into
 * the pack page: the reporter sees a message and can simply tap again.
 */
let loadedSheet: SheetComponent | null = null
async function loadSheet(): Promise<SheetComponent | null> {
  if (loadedSheet) return loadedSheet
  try {
    loadedSheet = (await import('@/components/photos/pack-photo-issue-sheet')).default
    return loadedSheet
  } catch {
    return null
  }
}

export type SavedIssue = { flagId: string; asanaStatus: AsanaIssueStatus }

export function PackPhotoIssue({
  propertyId,
  photoId,
  photoNumber,
  thumbUrl,
  initialIssues,
}: {
  propertyId: string
  photoId: string
  photoNumber: number
  thumbUrl?: string
  initialIssues: SavedIssue[]
}) {
  const { caption, packSubmitting } = usePackPhotoCaption(photoId)
  const [saved, setSaved] = useState<SavedIssue[]>(initialIssues)
  /** null = not mounted yet; otherwise the sheet for the current issue. */
  const [sheet, setSheet] = useState<{ key: number; caption: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [nextKey, setNextKey] = useState(1)
  const [Sheet, setSheetComponent] = useState<SheetComponent | null>(() => loadedSheet)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const openSheet = async () => {
    if (packSubmitting || loading) return
    let Loaded = Sheet
    if (!Loaded) {
      setLoading(true)
      setLoadFailed(false)
      Loaded = await loadSheet()
      setLoading(false)
      if (!Loaded) {
        setLoadFailed(true)
        return
      }
      const component = Loaded
      setSheetComponent(() => component)
    }
    if (!sheet) {
      // First open for this issue: the description starts from the photo's
      // CURRENT caption (the caption itself is never changed).
      setSheet({ key: nextKey, caption })
      setNextKey((k) => k + 1)
    }
    setOpen(true)
  }

  // Asana status keeps itself up to date: while an issue is still on its
  // way ("Sending to Asana" / status unavailable) a small read-only request
  // checks it and updates ONLY that label. No page refresh — captions, an
  // open form and the scroll position are untouched. Paused while the tab
  // is hidden; stops once every status is final or after a bounded number
  // of checks.
  const pendingKey = saved
    .filter((i) => isAsanaStatusPending(i.asanaStatus))
    .map((i) => i.flagId)
    .join(',')
  useEffect(() => {
    if (!pendingKey) return
    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (cancelled || attempt >= ASANA_STATUS_MAX_POLLS) return
      timer = setTimeout(tick, nextAsanaStatusPollDelayMs(attempt))
    }
    const tick = async () => {
      if (cancelled) return
      if (document.visibilityState === 'visible') {
        attempt += 1
        try {
          const res = await fetch(`/api/issues/asana-status?ids=${encodeURIComponent(pendingKey)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
          })
          if (res.ok && !cancelled) {
            const fresh = parseStatusResponse(await res.json())
            setSaved((list) => mergeIssueStatuses(list, fresh))
          }
        } catch {
          // Offline / interrupted: keep the current label and try again later.
        }
      }
      schedule()
    }
    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [pendingKey])

  const label = saved.length ? 'Report another issue' : 'Report issue'

  return (
    <div className="flex flex-col gap-2">
      {saved.map((issue) => (
        <div
          key={issue.flagId}
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm"
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-800">
            <Check size={16} aria-hidden /> Issue saved
          </span>
          <Link
            href={`/properties/${propertyId}/flags/${issue.flagId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center font-medium text-slate-900 underline underline-offset-4"
            aria-label={`View the issue saved for photo ${photoNumber} (opens a new tab)`}
          >
            View issue
          </Link>
          <span className="text-xs text-slate-600">{ASANA_STATUS_LABEL[issue.asanaStatus]}</span>
        </div>
      ))}

      <div>
        <button
          type="button"
          onClick={() => void openSheet()}
          disabled={packSubmitting || loading}
          aria-busy={loading}
          aria-haspopup="dialog"
          aria-label={`${label} for photo ${photoNumber}`}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          <Flag size={16} aria-hidden /> {loading ? 'Opening…' : label}
        </button>
        {loadFailed ? (
          <p role="alert" className="mt-1 text-xs text-red-700">
            Could not open the issue form. Check your connection and tap again.
          </p>
        ) : null}
      </div>

      {sheet && Sheet ? (
        <Sheet
          key={sheet.key}
          open={open}
          propertyId={propertyId}
          photoId={photoId}
          photoNumber={photoNumber}
          thumbUrl={thumbUrl}
          initialCaption={sheet.caption}
          onClose={() => setOpen(false)}
          onSaved={(issue) => {
            // Confirmed: show it on the card and discard the sheet whole.
            setSaved((list) => (list.some((i) => i.flagId === issue.flagId) ? list : [...list, issue]))
            setOpen(false)
            setSheet(null)
          }}
        />
      ) : null}
    </div>
  )
}
