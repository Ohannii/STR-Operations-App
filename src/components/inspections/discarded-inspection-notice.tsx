'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateTurnover } from '@/app/dashboard/work/actions'
import type { TurnoverJob } from '@/lib/inspections/workboard'
import { formatDateSAST } from '@/lib/ui/datetime'

export function DiscardedInspectionNotice({ job, manager }: { job: TurnoverJob; manager: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState('')
  return <section aria-label="Scheduled inspection" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
    <h2 className="font-semibold">Scheduled inspection · {formatDateSAST(`${job.due_on}T12:00:00+02:00`)}</h2>
    <p className="mt-2 text-sm font-medium">Draft discarded · Inspection still open</p>
    <p className="mt-1 text-sm">{manager ? 'Cancel this inspection to clear it. You can then schedule a replacement if needed.' : 'Ask a manager to cancel this inspection before scheduling a replacement.'}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {manager && <button type="button" disabled={pending} className="min-h-12 rounded-xl border border-amber-400 bg-white px-4 py-3 text-sm font-medium disabled:opacity-40" onClick={() => {
        if (pending) return
        start(async () => {
          setError('')
          const result = await updateTurnover(job.id, job.revision, job.due_on, true)
          if (!result.ok) { setError(result.error); return }
          router.refresh()
        })
      }}>{pending ? 'Cancelling…' : 'Cancel inspection'}</button>}
      <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/dashboard/work?${manager ? 'scope=all&' : ''}property=${job.property_id}`}>View inspection work</Link>
    </div>
    {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
  </section>
}
