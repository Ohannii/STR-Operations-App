'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { CancelInspectionControl } from './cancel-inspection-control'
import type { TurnoverJob } from '@/lib/inspections/workboard'
import { formatDateSAST } from '@/lib/ui/datetime'

export function DiscardedInspectionNotice({ job, manager, propertyName }: { job: TurnoverJob; manager: boolean; propertyName: string }) {
  return <section aria-label="Scheduled inspection" className="flex items-start justify-between gap-2 py-1">
    <div className="min-w-0">
      <h2 className="text-sm font-medium text-slate-800">Inspection <span className="font-normal text-slate-500">· {formatDateSAST(`${job.due_on}T12:00:00+02:00`, 'short')}</span></h2>
      <p className="mt-2 flex items-start gap-2 text-sm leading-relaxed text-slate-600"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />Draft discarded. Inspection still open.</p>
      {!manager && <p className="mt-1 text-xs text-slate-500">Ask a manager to review this inspection.</p>}
      <Link className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-950" href={`/dashboard/work?${manager ? 'scope=all&' : ''}property=${job.property_id}`}>View inspection <ChevronRight size={14} aria-hidden /></Link>
    </div>
    {manager && <CancelInspectionControl job={job} propertyName={propertyName} />}
  </section>
}
