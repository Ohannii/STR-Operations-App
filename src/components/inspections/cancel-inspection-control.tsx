'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MoreHorizontal } from 'lucide-react'
import { updateTurnover } from '@/app/dashboard/work/actions'
import type { TurnoverJob } from '@/lib/inspections/workboard'
import { formatDateSAST } from '@/lib/ui/datetime'

/** Cancellation is a secondary action and never runs until explicitly confirmed. */
export function CancelInspectionControl({ job, propertyName, disabled = false }: {
  job: TurnoverJob; propertyName: string; disabled?: boolean
}) {
  const router = useRouter()
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuItem = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const saving = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!menuOpen) return
    menuItem.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    const focusOutside = (e: FocusEvent) => {
      if (!container.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('focusin', focusOutside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focusOutside) }
  }, [menuOpen])

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

  return <div ref={container} className="relative shrink-0">
    <button ref={trigger} type="button" aria-label="Inspection actions" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`${id}-menu`} disabled={disabled || pending}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40"
      onClick={() => setMenuOpen(open => !open)}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMenuOpen(true) } }}>
      <MoreHorizontal size={19} aria-hidden />
    </button>
    {menuOpen && <div id={`${id}-menu`} role="menu" aria-label="Inspection actions" className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setMenuOpen(false); trigger.current?.focus() }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); menuItem.current?.focus() }
      }}>
      <button ref={menuItem} type="button" role="menuitem" className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-rose-700 hover:bg-rose-50 focus-visible:bg-rose-50 focus-visible:outline-none"
        onClick={() => { setError(''); setMenuOpen(false); setConfirming(true) }}>Cancel inspection…</button>
    </div>}
    {confirming && <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
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
