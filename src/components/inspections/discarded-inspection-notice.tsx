'use client'

import Link from 'next/link'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { CancelInspectionControl } from './cancel-inspection-control'
import type { TurnoverJob } from '@/lib/inspections/workboard'
import { formatDateSAST } from '@/lib/ui/datetime'

export function DiscardedInspectionNotice({ job, manager, propertyName }: { job: TurnoverJob; manager: boolean; propertyName: string }) {
  return <section aria-label="Scheduled inspection" className="rounded-xl border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50 p-4">
    <div className="flex items-center gap-2 text-amber-900"><AlertTriangle size={18} className="shrink-0" aria-hidden /><h2 className="text-base font-semibold">Inspection needs attention</h2></div>
    <p className="mt-1 text-sm text-amber-900">{formatDateSAST(`${job.due_on}T12:00:00+02:00`, 'short')} · Inspection still open</p>
    <p className="mt-3 text-sm leading-relaxed text-slate-700">Draft discarded. {manager ? 'To start again, use Options to cancel this inspection, then open inspection work to arrange a replacement.' : 'Ask a manager to arrange a replacement before starting again.'}</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <Link className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700" href={`/dashboard/work?${manager ? 'scope=all&' : ''}property=${job.property_id}`}>Open inspection work <ChevronRight size={15} aria-hidden /></Link>
      {manager && <CancelInspectionControl job={job} propertyName={propertyName} />}
    </div>
  </section>
}
