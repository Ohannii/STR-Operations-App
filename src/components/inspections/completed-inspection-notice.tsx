import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import type { InspectionCompletion } from '@/lib/inspections/completion'
import { inspectionWorkHref } from '@/lib/inspections/workboard'
import { formatDateSAST, formatDateTimeSAST } from '@/lib/ui/datetime'

export function CompletedInspectionNotice({ job }: { job: InspectionCompletion }) {
  return <section aria-label="Completed inspection" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
    <h2 className="flex items-center gap-2 text-lg font-semibold text-emerald-950"><CheckCircle2 size={22} className="shrink-0 text-emerald-700" aria-hidden />Inspection complete</h2>
    {job.due_on && <p className="mt-2 text-sm text-emerald-950">Inspection date: {formatDateSAST(`${job.due_on}T12:00:00+02:00`, 'short')}</p>}
    <p className="mt-1 text-sm text-emerald-950">Submitted by {job.submitter_name ?? 'Team member'} · {formatDateTimeSAST(job.submitted_at)}</p>
    <p className="mt-2 text-sm leading-relaxed text-slate-700">The inspection is recorded. Open issues and guest readiness are tracked separately.</p>
    <Link href={inspectionWorkHref(job.due_on ? 'submitted' : 'due')} className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">Back to my inspections</Link>
    <Link href={`/properties/${job.property_id}/packs/${job.pack_id}/report`} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-teal-800 underline underline-offset-4">View submitted inspection</Link>
  </section>
}
