'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { updateTurnover } from '@/app/dashboard/work/actions'
import type { TurnoverJob } from '@/lib/inspections/workboard'
import { formatDateSAST } from '@/lib/ui/datetime'

/** Cancellation is a secondary action and never runs until explicitly confirmed. */
export function CancelInspectionControl({ job, propertyName, disabled = false }: {
  job: TurnoverJob; propertyName: string; disabled?: boolean
}) {
  const router = useRouter()
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const saving = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!confirming) return
    const element = dialog.current
    if (!element) return
    const returnFocus = trigger.current
    element.showModal()
    keep.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      if (element.open) element.close()
      document.body.style.overflow = previous
      returnFocus?.focus()
    }
  }, [confirming])

  const dismiss = () => { if (!saving.current) setConfirming(false) }
  const confirm = () => {
    if (!confirming || !dialog.current?.open || saving.current) return
    saving.current = true
    setError('')
    start(async () => {
      try {
        const result = await updateTurnover(job.id, job.revision, job.due_on, true)
        if (!result.ok) { setError(result.error); return }
        setConfirming(false)
        router.refresh()
      } catch {
        setError('Could not confirm cancellation. Reload to check the inspection before trying again.')
      } finally { saving.current = false }
    })
  }

  return <div className="shrink-0">
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={confirming} aria-controls={`${id}-confirmation`} disabled={disabled || pending}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-700 focus-visible:ring-offset-2 disabled:opacity-40"
      onClick={() => { setError(''); setConfirming(true) }}>
      <Trash2 size={15} aria-hidden /><span>Cancel inspection…</span>
    </button>
    {confirming && <dialog id={`${id}-confirmation`} ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto overscroll-contain rounded-2xl border-0 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/35"
      onCancel={e => { e.preventDefault(); dismiss() }}>
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">Cancel this inspection?</h2>
      <p className="mt-2 text-sm font-medium">{propertyName} · {formatDateSAST(`${job.due_on}T12:00:00+02:00`, 'short')}</p>
      <p id={`${id}-description`} className="mt-2 text-sm leading-relaxed text-slate-600">This removes the inspection from open work. Existing pack history and photos are kept.</p>
      {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={keep} type="button" disabled={pending} onClick={dismiss} className="min-h-11 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">Keep inspection</button>
        <button type="button" disabled={pending} onClick={confirm} className="min-h-11 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40">{pending ? 'Cancelling…' : 'Cancel inspection'}</button>
      </div>
    </dialog>}
  </div>
}
