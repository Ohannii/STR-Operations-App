'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, CloudOff, Loader2 } from 'lucide-react'
import {
  saveDraftPhotoCaptionAction,
  submitPackWithCaptionsAction,
} from '@/app/properties/[id]/packs/actions'
import {
  CaptionAutosave,
  type CaptionPageStatus,
  type CaptionPhotoStatus,
} from '@/lib/photos/caption-autosave'
import {
  applySubmittedRecovery,
  captionManifestKey,
  discardDeviceCaptions,
  type CaptionOrphans,
  type SubmittedRecoveryItem,
} from '@/lib/photos/caption-drafts'
import { copyTextWithFallback } from '@/lib/photos/caption-outcomes'
import { FLUSH_FAILED_MESSAGE, runSaveAndSubmit } from '@/lib/photos/caption-submit'
import { usePackQueue } from '@/lib/photos/photo-queue'

/**
 * Pack-report caption editor (P0, 22 Oct 2026).
 *
 * Replaces the unsafe one-form-per-photo + separate-Submit layout that lost
 * 40 captions for Unit 377: typed values now go to DEVICE storage on every
 * keystroke, autosave to the server with bounded retry, and the ONE final
 * action is "Save captions and submit pack" — a single server transaction
 * that saves every current caption value and finalises only if all of it
 * succeeds.
 *
 * Truthful states only: 'Saved' is never shown from React state alone — it
 * means the server acknowledged exactly the text on screen.
 */

type BackupState =
  | { status: 'idle' }
  | { status: 'copied' }
  /** Clipboard unavailable or refused: the text is shown for manual copy. */
  | { status: 'manual'; text: string }

type EditorCtx = {
  textFor: (photoId: string) => string
  statusFor: (photoId: string) => CaptionPhotoStatus
  conflictServerFor: (photoId: string) => string | null | undefined
  edit: (photoId: string, text: string) => void
  keepMine: (photoId: string) => void
  takeServerVersion: (photoId: string) => void
  retrySaves: () => void
  copyCaptions: () => void
  orphans: CaptionOrphans
  discardOrphans: () => void
  backup: BackupState
  page: CaptionPageStatus
  packId: string
  submit: () => void
  submitting: boolean
  submitError: string | null
  submitConflict: boolean
}

const Ctx = createContext<EditorCtx | null>(null)

export function PackCaptionProvider({
  propertyId,
  packId,
  serverNotes,
  children,
}: {
  propertyId: string
  packId: string
  /** photoId -> server-rendered caption (null = none). */
  serverNotes: Record<string, string | null>
  children: ReactNode
}) {
  const router = useRouter()
  const [, setTick] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitConflict, setSubmitConflict] = useState(false)
  const [backup, setBackup] = useState<BackupState>({ status: 'idle' })
  const submittingRef = useRef(false)

  const controller = useMemo(
    () =>
      new CaptionAutosave({
        packId,
        save: async (photoId, note, expected) => {
          try {
            const res = await saveDraftPhotoCaptionAction({
              photoId,
              note,
              // Database COMPARE-AND-SET, always (no bypass flag exists): a
              // stale belief returns 'stale' with zero writes.
              expectedNotes: expected,
            })
            if (res.ok) return { ok: true }
            if (res.code === 'stale') {
              return { ok: false, code: 'stale', error: res.error, serverNotes: res.serverNotes }
            }
            return { ok: false, error: res.error, retryable: res.retryable }
          } catch (err) {
            // Network/transport failure: retryable, draft stays on device.
            return {
              ok: false,
              error: err instanceof Error ? err.message : 'Network error',
              retryable: true,
            }
          }
        },
        onChange: () => setTick((t) => t + 1),
      }),
    // The pack identity defines the controller; server notes seed it below.
    [packId],
  )

  // Seed per mount: restore this device's caption journal over the server
  // captions. seed() starts a NEW controller generation and RE-ACTIVATES the
  // controller, so React Strict Mode's setup -> cleanup -> setup on this same
  // memoized controller can never leave it disposed — and a save from the
  // cleaned-up generation can never write into the new one (rev 6).
  useEffect(() => {
    controller.seed(serverNotes)
    const onOnline = () => controller.notifyOnline()
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
      controller.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller])

  // MANIFEST RECONCILIATION (rev 4): a server refresh that keeps this
  // provider mounted (e.g. photos attached or removed elsewhere) changes the photo SET
  // for the same pack. Key on the sorted id set — not on object identity — so
  // ordinary re-renders never touch the controller; only a real manifest
  // change drops absent ids and seeds new ones (dirty/conflicted captions of
  // surviving photos are preserved; in-flight saves for removed photos
  // resolve harmlessly against a missing entry).
  // rev 5: ids AND canonical server captions — same photos with a changed
  // server caption is a manifest change; an identical re-render is a no-op.
  const manifestKey = captionManifestKey(serverNotes)
  const seededKey = useRef<string | null>(null)
  useEffect(() => {
    if (seededKey.current === null) {
      seededKey.current = manifestKey // the seed effect handled this set
      return
    }
    if (seededKey.current === manifestKey) return
    seededKey.current = manifestKey
    controller.reconcileManifest(serverNotes)
    // serverNotes is read for the CURRENT manifest only when its key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, manifestKey])

  const page = controller.pageStatus()

  // Leaving with unsynced captions must warn (they ARE still on the device,
  // but the inspector should know the server hasn't got them yet).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (controller.pageStatus().blocking) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [controller])

  const submit = useCallback(() => {
    // Duplicate-tap guard: ref flips synchronously, state drives the UI.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    setSubmitConflict(false)
    void (async () => {
      try {
        // runSaveAndSubmit (behaviour-tested): freezes editing, STOPS if any
        // caption is not server-confirmed, sends the complete manifest with
        // baselines, and acknowledges only what the server confirmed.
        const outcome = await runSaveAndSubmit(controller, (manifest) =>
          submitPackWithCaptionsAction({ propertyId, packId, captions: manifest }),
        )
        if (outcome.kind === 'flush_failed') {
          setSubmitError(FLUSH_FAILED_MESSAGE)
          return
        }
        if (outcome.kind === 'conflict') {
          setSubmitError(outcome.error)
          setSubmitConflict(true)
          return
        }
        if (outcome.kind === 'failed') {
          setSubmitError(outcome.error)
          return
        }
        if (outcome.leftover.length > 0) {
          // Defensive: editing is frozen, so this should not happen — but if
          // any newer local text exists it is KEPT and the user is told.
          setSubmitError(
            'The pack was submitted, but some caption text on this device is newer than what was submitted. ' +
              'It has been kept — copy it below before leaving.',
          )
          setSubmitConflict(true)
          return
        }
        router.push(`/properties/${propertyId}?pack_submitted=1`)
        router.refresh()
      } catch (err) {
        console.error('[pack-captions] submit failed:', err instanceof Error ? err.name : typeof err)
        setSubmitError(
          'The pack could not be submitted. It is still a draft and your captions are kept on this device.',
        )
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    })()
  }, [controller, packId, propertyId, router])

  const value: EditorCtx = {
    textFor: (id) => controller.textFor(id),
    statusFor: (id) => controller.statusFor(id),
    conflictServerFor: (id) => controller.conflictServerFor(id),
    edit: (id, text) => {
      controller.edit(id, text) // refused (no change) while submitting
    },
    keepMine: (id) => controller.keepMine(id),
    takeServerVersion: (id) => controller.takeServerVersion(id),
    retrySaves: () => void controller.flushAll(),
    // TRUTHFUL BACKUP (blocker 9): "Copied" is shown ONLY when the clipboard
    // write is confirmed; otherwise the text is exposed for manual copy.
    // Never logged — only placed where the user asked.
    copyCaptions: () => {
      const current = controller
        .snapshotAll()
        .map((c, i) => `Photo ${i + 1} (${c.photoId}): ${c.note || '(blank)'}`)
      const removed = Object.values(controller.getOrphans()).map((o) =>
        o.reason === 'removed'
          ? `Removed photo (${o.photoId}): ${o.text || '(blank)'}`
          : `Other copy on this device (${o.photoId}): ${o.text || '(blank)'}`,
      )
      const text = [...current, ...removed].join('\n')
      void copyTextWithFallback(
        text,
        typeof navigator === 'undefined' ? null : navigator.clipboard,
      ).then((r) => setBackup(r === 'copied' ? { status: 'copied' } : { status: 'manual', text }))
    },
    backup,
    orphans: controller.getOrphans(),
    discardOrphans: () => controller.discardOrphans(),
    page,
    packId,
    submit,
    submitting,
    submitError,
    submitConflict,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function useEditor(): EditorCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('PackCaption components must sit inside PackCaptionProvider')
  return ctx
}

function statusLine(status: CaptionPhotoStatus, deviceDurable: boolean) {
  switch (status) {
    case 'saving':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
          <Loader2 size={11} className="animate-spin" aria-hidden /> Saving…
        </span>
      )
    case 'clean':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
          <Check size={11} aria-hidden /> Saved
        </span>
      )
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
          <CloudOff size={11} aria-hidden />
          {deviceDurable
            ? 'Saved on device — waiting for connection'
            : 'Not saved yet — keep this page open'}
        </span>
      )
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-700">
          <AlertTriangle size={11} aria-hidden />
          {deviceDurable
            ? 'Could not save — kept on this device, will retry on submit'
            : 'Could not save — keep this page open and retry'}
        </span>
      )
    case 'conflict':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-700">
          <AlertTriangle size={11} aria-hidden />
          Changed on another device — choose a version below
        </span>
      )
    default: // dirty (debouncing)
      return (
        <span className="text-[11px] text-slate-500">
          {deviceDurable ? 'Saved on device — syncing…' : 'Typing…'}
        </span>
      )
  }
}

/** One photo's caption field. Every change is device-durable immediately;
 *  read-only while a submission is in flight; conflicts need a choice. */
export function PackCaptionField({ photoId }: { photoId: string }) {
  const { textFor, statusFor, conflictServerFor, edit, keepMine, takeServerVersion, page, submitting } =
    useEditor()
  const status = statusFor(photoId)
  const server = conflictServerFor(photoId)
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={`note-${photoId}`}
        className="text-[10px] font-semibold uppercase tracking-wider text-slate-500"
      >
        Caption (optional)
      </label>
      <textarea
        id={`note-${photoId}`}
        rows={2}
        maxLength={2000}
        value={textFor(photoId)}
        readOnly={submitting}
        aria-readonly={submitting}
        onChange={(e) => edit(photoId, e.target.value)}
        placeholder="What is this photo of? — optional"
        className="w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 resize-y read-only:bg-slate-50"
      />
      {statusLine(status, page.deviceDurable)}
      {status === 'conflict' ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
          {typeof server === 'string' ? (
            <>
              <p>
                <span className="font-semibold">Saved version from the other device:</span>{' '}
                {server ? server : <span className="italic">(blank)</span>}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => keepMine(photoId)}
                  className="rounded border border-red-300 bg-white px-2 py-1 font-medium"
                >
                  Keep my caption
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => takeServerVersion(photoId)}
                  className="rounded border border-red-300 bg-white px-2 py-1 font-medium"
                >
                  Use the saved version
                </button>
              </div>
            </>
          ) : (
            <p>
              The saved version could not be read. Reload this page to compare —
              your caption above is kept on this device.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Compact page-level caption state for the sticky header. */
export function PackCaptionStatusChip() {
  const { page } = useEditor()
  if (!page.blocking) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800">
        <Check size={11} aria-hidden /> Captions saved
      </span>
    )
  }
  const text = page.conflicts > 0
    ? `${page.conflicts} caption${page.conflicts === 1 ? '' : 's'} changed elsewhere — choose a version`
    : page.failed > 0
    ? `${page.failed} caption${page.failed === 1 ? '' : 's'} could not save`
    : page.offline
      ? 'Captions saved on device — waiting for connection'
      : 'Saving captions…'
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
      {page.failed > 0 || page.conflicts > 0 ? (
        <AlertTriangle size={11} aria-hidden />
      ) : (
        <Loader2 size={11} className="animate-spin" aria-hidden />
      )}
      {text}
    </span>
  )
}

/**
 * The ONE final action: "Save captions and submit pack". Disabled while any
 * caption is dirty / saving / offline-unsynced / failed, and while a submit
 * is already in flight. On any failure the pack stays a draft and every
 * draft stays on the device — no silent clears, no fake success.
 */
export function PackCaptionSubmit({ photoCount }: { photoCount: number }) {
  const {
    page,
    submit,
    submitting,
    submitError,
    submitConflict,
    retrySaves,
    copyCaptions,
    backup,
    packId,
    orphans,
    discardOrphans,
  } = useEditor()
  const orphanIds = Object.keys(orphans)
  // The device photo queue gate this page had before (via PackSubmitButton)
  // is preserved: photos still uploading from this device block submission.
  // The finalize RPC re-proves all of it server-side regardless.
  const queue = usePackQueue(packId)
  const queueBlocked = queue.summary.blocking || queue.storageError !== null
  const blocked = page.blocking || queueBlocked || submitting
  const reason = submitting
    ? 'Submitting…'
    : page.conflicts > 0
      ? 'Some captions were changed on another device — choose a version for each highlighted photo.'
      : page.failed > 0
      ? 'Some captions could not be saved. Check your connection, then tap Retry saving.'
      : page.saving > 0 || page.dirty > 0
        ? 'Waiting for captions to finish saving…'
        : queueBlocked
          ? (queue.describe ?? 'Photos on this device are still uploading…')
          : undefined
  return (
    <div className="flex flex-col gap-2">
      {submitError ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </p>
      ) : null}
      <button
        type="button"
        onClick={submit}
        disabled={blocked}
        aria-disabled={blocked}
        title={typeof reason === 'string' ? reason : reason?.text}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 active:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 sm:w-auto"
      >
        {submitting ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <Check size={15} aria-hidden />
        )}
        {submitting
          ? 'Saving captions and submitting…'
          : `Save captions and submit pack (${photoCount})`}
      </button>
      {reason && !submitting ? (
        <span className="text-[11px] text-amber-700">
          {typeof reason === 'string' ? reason : reason?.text}
        </span>
      ) : null}
      {page.failed > 0 && !submitting && !submitConflict ? (
        <button
          type="button"
          onClick={retrySaves}
          className="inline-flex w-fit items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Retry saving captions
        </button>
      ) : null}
      {/* Safe recovery (blockers 4+6): when the device store is unusable,
          saves failed, or the pack was submitted elsewhere with different
          captions, the typed text can always be exported by the user. */}
      {(submitConflict || page.failed > 0 || page.conflicts > 0 || !page.deviceDurable) &&
      !submitting ? (
        <button
          type="button"
          onClick={copyCaptions}
          className="inline-flex w-fit items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Copy my captions (backup)
        </button>
      ) : null}
      {backup.status === 'copied' ? (
        <span role="status" className="text-[11px] text-emerald-700">
          Captions copied to the clipboard.
        </span>
      ) : null}
      {backup.status === 'manual' ? (
        <div role="status" className="flex flex-col gap-1">
          <span className="text-[11px] text-amber-800">
            Copying is not available here. Select the text below and copy it
            manually — it is NOT backed up until you do.
          </span>
          <textarea
            readOnly
            rows={6}
            value={backup.text}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-800"
          />
        </div>
      ) : null}
      {!page.deviceDurable ? (
        <span className="text-[11px] text-red-700">
          This device could not store caption drafts (storage blocked or
          full). Keep this page open until everything shows Saved, or copy
          your captions as a backup.
        </span>
      ) : null}
      {/* DEVICE RECOVERY (rev 5/6): unsynced text of photos that left the
          pack, and other copies left by another tab on this device, is NOT
          submitted, but is kept here until explicitly discarded. */}
      {orphanIds.length > 0 && !submitting ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-semibold">
            {orphanIds.length} other caption{orphanIds.length === 1 ? '' : 's'} on this device
            will not be submitted, but {orphanIds.length === 1 ? 'is' : 'are'} kept here until
            you discard {orphanIds.length === 1 ? 'it' : 'them'}:
          </p>
          <ul className="mt-1 list-disc pl-4">
            {orphanIds.map((id) => (
              <li key={id} className="break-words">
                <span className="font-medium">
                  {orphans[id].reason === 'removed'
                    ? 'Photo no longer in this pack: '
                    : 'Other copy from another tab: '}
                </span>
                {orphans[id].text || <span className="italic">(blank)</span>}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyCaptions}
              className="rounded border border-amber-400 bg-white px-2 py-1 font-medium"
            >
              Copy them
            </button>
            <button
              type="button"
              onClick={() => {
                const ok =
                  typeof window === 'undefined' ||
                  window.confirm('Discard these captions from this device? This cannot be undone.')
                if (ok) discardOrphans()
              }}
              className="rounded border border-amber-400 bg-white px-2 py-1 font-medium"
            >
              Discard them
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * SUBMITTED-PACK RECOVERY (rev 5). Mounted on the report of a SUBMITTED
 * (immutable, read-only) pack. Compares this device's leftover caption drafts
 * with the FINAL server captions: proven-identical drafts are cleared (the
 * submit committed even if its response was lost); anything that differs or
 * belongs to a photo not in the submitted pack is shown for copy / manual
 * copy and kept until the inspector explicitly discards it. It never calls
 * the server and never mutates the submitted pack.
 */
export function SubmittedCaptionRecovery({
  packId,
  serverNotes,
}: {
  packId: string
  serverNotes: Record<string, string | null>
}) {
  const [items, setItems] = useState<SubmittedRecoveryItem[]>([])
  const [backup, setBackup] = useState<BackupState>({ status: 'idle' })
  const manifestKey = captionManifestKey(serverNotes)
  useEffect(() => {
    // Device storage exists only in the browser: read it after mount.
    const found = applySubmittedRecovery(packId, serverNotes)
    queueMicrotask(() => setItems(found))
    // serverNotes is captured through its content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, manifestKey])
  if (items.length === 0) return null
  const text = items
    .map((it) =>
      it.kind === 'differs'
        ? `Photo ${it.photoId} — your text: ${it.local || '(blank)'} | submitted: ${it.server || '(blank)'}`
        : `Photo ${it.photoId} (not in the submitted pack) — your text: ${it.local || '(blank)'}`,
    )
    .join('\n')
  return (
    <div className="mx-auto max-w-4xl px-6 pt-4 print:hidden">
      <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">
          This pack was submitted, but this device still holds {items.length} caption
          {items.length === 1 ? '' : 's'} that differ from the submitted record.
        </p>
        <p className="mt-1 text-xs">
          The submitted pack cannot change. Copy anything you still need before discarding it.
        </p>
        <ul className="mt-2 list-disc pl-4 text-xs">
          {items.map((it) => (
            <li key={it.id} className="break-words">
              <span className="font-medium">Your text:</span> {it.local || <em>(blank)</em>}
              {it.kind === 'differs' ? (
                <>
                  {' '}
                  — <span className="font-medium">submitted:</span> {it.server || <em>(blank)</em>}
                </>
              ) : (
                <> — photo not in the submitted pack</>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() =>
              void copyTextWithFallback(
                text,
                typeof navigator === 'undefined' ? null : navigator.clipboard,
              ).then((r) => setBackup(r === 'copied' ? { status: 'copied' } : { status: 'manual', text }))
            }
            className="rounded border border-amber-400 bg-white px-2 py-1 font-medium"
          >
            Copy my captions
          </button>
          <button
            type="button"
            onClick={() => {
              const ok =
                typeof window === 'undefined' ||
                window.confirm('Discard these captions from this device? This cannot be undone.')
              if (ok) {
                // Removes exactly the copies shown (unchanged since read).
                discardDeviceCaptions(items)
                setItems([])
              }
            }}
            className="rounded border border-amber-400 bg-white px-2 py-1 font-medium"
          >
            Discard from this device
          </button>
        </div>
        {backup.status === 'copied' ? (
          <p className="mt-1 text-xs text-emerald-700">Captions copied to the clipboard.</p>
        ) : null}
        {backup.status === 'manual' ? (
          <div className="mt-1">
            <p className="text-xs">
              Copying is not available here. Select the text below and copy it manually — it is
              NOT backed up until you do.
            </p>
            <textarea
              readOnly
              rows={5}
              value={backup.text}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
