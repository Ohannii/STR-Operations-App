'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { finalizeFlagWithPhotos } from '@/app/properties/[id]/flags/new/actions'
import { preparePackPhotoForIssueAction } from '@/app/properties/[id]/photos/actions'
import { PackPhotoIssueForm } from '@/components/photos/pack-photo-issue-form'
import type { AsanaIssueStatus } from '@/lib/issues/asana-status'
import {
  initialIssueSheetState,
  issueSheetReducer,
  runIssueSave,
  type IssueSheetAction,
  type IssueSheetState,
} from '@/lib/issues/issue-sheet-state'
import { listReportableCategoryDisplays } from '@/lib/ui/flag-category'

/**
 * The "Report issue" sheet for ONE pack photo. Loaded and mounted only when
 * the reporter first opens it (see pack-photo-issue.tsx), so the pack page
 * does not render a hidden form + thumbnail per photo.
 *
 * It stays mounted after Cancel (entries are kept for reopening) and is
 * unmounted by the parent after a confirmed save (entries cleared; the next
 * issue gets fresh ids).
 *
 * All behaviour lives in issue-sheet-state.ts: the form is frozen while a
 * save runs, and the issue id + photo id are fixed for this mount, so
 * repeated taps or retries can only ever produce ONE issue.
 */

function newUuid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
}

export type PackPhotoIssueSheetProps = {
  open: boolean
  propertyId: string
  photoId: string
  photoNumber: number
  thumbUrl?: string
  /** The photo's caption when the sheet was first opened for this issue. */
  initialCaption: string
  onClose: () => void
  onSaved: (issue: { flagId: string; asanaStatus: AsanaIssueStatus }) => void
}

export default function PackPhotoIssueSheet({
  open,
  propertyId,
  photoId,
  photoNumber,
  thumbUrl,
  initialCaption,
  onClose,
  onSaved,
}: PackPhotoIssueSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const fieldId = useId()
  const issueTypes = listReportableCategoryDisplays()

  // Fixed for this issue (this mount): every retry replays the SAME issue.
  const [ids] = useState(() => ({ flagId: newUuid(), photoId: newUuid() }))

  // State is applied synchronously to a ref as well, so the single-flight
  // and freeze checks never read a stale render.
  const [state, setState] = useState<IssueSheetState>(() => initialIssueSheetState(initialCaption))
  const stateRef = useRef(state)
  const dispatch = useCallback((action: IssueSheetAction) => {
    const next = issueSheetReducer(stateRef.current, action)
    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
    }
  }, [])

  // Open / close the native dialog; lock page scroll only while open.
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const requestClose = () => {
    if (stateRef.current.saving) return // never close mid-save
    onClose()
  }

  const save = async () => {
    const outcome = await runIssueSave(
      { prepare: preparePackPhotoForIssueAction, finalize: finalizeFlagWithPhotos },
      { propertyId, packPhotoId: photoId, ids },
      () => stateRef.current,
      dispatch,
    )
    if (outcome.ok) onSaved({ flagId: outcome.flagId, asanaStatus: outcome.asanaStatus })
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="m-auto mb-0 max-h-[92dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-2xl bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/45 sm:mb-auto sm:rounded-2xl"
      onCancel={(event) => {
        // Esc / Android back: handled by state, never by the browser alone.
        event.preventDefault()
        requestClose()
      }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            Report an issue
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">Photo {photoNumber} · Pre-arrival pack</p>
        </div>
        <button
          type="button"
          aria-label="Close"
          disabled={state.saving}
          onClick={requestClose}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-40"
        >
          <X size={20} aria-hidden />
        </button>
      </div>

      <PackPhotoIssueForm
        fieldId={fieldId}
        state={state}
        dispatch={dispatch}
        issueTypes={issueTypes}
        thumbUrl={thumbUrl}
        onSubmit={() => void save()}
        onCancel={requestClose}
      />
    </dialog>
  )
}
