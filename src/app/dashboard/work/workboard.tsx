'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { scheduleTurnover, updateTurnover } from './actions'
import { InspectionStartButton } from '@/components/inspections/inspection-start-button'
import { CancelInspectionControl } from '@/components/inspections/cancel-inspection-control'
import { jobState, propertyLabel, type Allocation, type InspectionWorkspace, type TurnoverJob } from '@/lib/inspections/workboard'
import { naturalCompare } from '@/lib/properties/finder'
import { formatDateSAST, formatDateTimeSAST } from '@/lib/ui/datetime'

const control = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base'
const primary = 'min-h-12 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40'
const dayLabel = (day: string) => formatDateSAST(`${day}T12:00:00+02:00`)

export function Workboard({ workspace, jobs, manager, all, userId, today, initialProperty }: {
  workspace: InspectionWorkspace; jobs: TurnoverJob[]; manager: boolean; all: boolean; userId: string; today: string; initialProperty: string
}) {
  const [filter, setFilter] = useState('due')
  const [query, setQuery] = useState(initialProperty)
  const props = new Map(workspace.properties.map(p => [p.id, p]))
  const assigned = workspace.properties.filter(p => p.inspector_id === userId)
  const tabs = [['due', 'Due & overdue'], ['upcoming', 'Upcoming'], ['submitted', 'Completed'], ['cancelled', 'Cancelled']] as const
  const matches = (j: TurnoverJob, f: string) => f === 'due' ? ['today', 'overdue', 'needs_attention'].includes(jobState(j, today)) : jobState(j, today) === f
  const visible = jobs.filter(j => props.has(j.property_id) && matches(j, filter) && (!query || j.property_id === query || propertyLabel(props.get(j.property_id)!).toLowerCase().includes(query.trim().toLowerCase())))
  const checkoutsToday = jobs.filter(j => j.checkout_at && new Date(j.checkout_at).getTime() >= new Date(`${today}T00:00:00+02:00`).getTime()
    && new Date(j.checkout_at).getTime() < new Date(`${today}T00:00:00+02:00`).getTime() + 86400000 && !j.cancelled_at).length
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3"><div className="rounded-xl bg-white p-4"><p className="text-2xl font-semibold">{all ? workspace.properties.filter(p => !p.inspector_id || !p.inspector_active).length : assigned.length}</p><p className="text-sm text-slate-600">{all ? 'Unassigned or unavailable inspector' : 'Apartments allocated to you'}</p></div><div className="rounded-xl bg-white p-4"><p className="text-2xl font-semibold">{checkoutsToday}</p><p className="text-sm text-slate-600">Manually scheduled checkouts today</p></div></div>
    {jobs.some(j => !props.has(j.property_id)) && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm">An apartment changed while this page loaded. Reload to see the latest inspection list.</p>}
    {manager && <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer font-medium">Schedule an inspection (test or exception)</summary><ScheduleForm properties={workspace.properties} today={today} /></details>}
    {!all && <p className="text-sm text-slate-600">Your allocated work, packs you started or submitted, and open inspections without an available primary inspector.</p>}
    <nav aria-label="Inspection state" className="flex flex-wrap gap-2">{tabs.map(([key, label]) => <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={`min-h-11 rounded-full px-4 text-sm ${filter === key ? 'bg-slate-900 text-white' : 'border border-slate-200 bg-white'}`}>{label} ({jobs.filter(j => matches(j, key)).length})</button>)}</nav>
    <label className="block text-sm">Find an apartment<input className={`${control} mt-1`} value={query === initialProperty && props.has(initialProperty) ? propertyLabel(props.get(initialProperty)!) : query} onChange={e => setQuery(e.target.value)} placeholder="Estate or unit" /></label>
    {visible.length ? <ul className="grid gap-4 lg:grid-cols-2">{visible.map(j => <li key={`${j.id}:${j.revision}:${j.pack_status}`}><InspectionJobCard job={j} property={props.get(j.property_id)!} manager={manager} today={today} /></li>)}</ul>
      : <div className="rounded-xl border border-dashed border-slate-300 p-6"><p className="font-medium">No {filter === 'due' ? 'due inspections' : filter === 'submitted' ? 'completed inspections' : `${filter} inspections`} in this view.</p><p className="mt-2 text-sm text-slate-600">{jobs.length === 0 ? 'There is no scheduled work in this view. Allocation alone does not create an inspection. Open unassigned inspections also appear here.' : 'Try another filter or search.'}</p></div>}
    {!all && <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer font-medium">My allocated apartments ({assigned.length})</summary><p className="mb-3 text-sm text-slate-600">Allocation alone does not mean an inspection is due.</p><ul className="space-y-1">{assigned.sort((a, b) => naturalCompare(propertyLabel(a), propertyLabel(b))).map(p => <li key={p.id}><Link className="inline-flex min-h-11 items-center underline" href={`/properties/${p.id}`}>{propertyLabel(p)}</Link></li>)}</ul></details>}
  </div>
}

export function ScheduleForm({ properties, today }: { properties: Allocation[]; today: string }) {
  const router = useRouter()
  const [nonce, setNonce] = useState(() => crypto.randomUUID())
  const [propertyId, setPropertyId] = useState('')
  const [due, setDue] = useState(today)
  const [checkout, setCheckout] = useState('')
  const [arrival, setArrival] = useState('')
  const [message, setMessage] = useState('')
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()
  const selected = properties.find(p => p.id === propertyId)
  // Freeze the whole form during a request; retry keeps the same nonce/values.
  return <form className="mt-4" onSubmit={e => { e.preventDefault(); if (pending) return; start(async () => {
    const result = await scheduleTurnover({ id: nonce, propertyId, due, checkout, arrival })
    setSaved(result.ok)
    setMessage(result.ok ? 'Inspection scheduled.' : result.error)
    if (result.ok) { setNonce(crypto.randomUUID()); setPropertyId(''); setCheckout(''); setArrival(''); router.refresh() }
  }) }}>
    <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm sm:col-span-2">Apartment<select required className={control} value={propertyId} onChange={e => setPropertyId(e.target.value)}><option value="">Choose an apartment…</option>{[...properties].sort((a, b) => naturalCompare(propertyLabel(a), propertyLabel(b))).map(p => <option key={p.id} value={p.id}>{propertyLabel(p)}</option>)}</select></label>
      {selected && (!selected.inspector_id || !selected.inspector_active) && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-2">No available primary inspector. This inspection will appear as unassigned in the team’s work lists.</p>}
      <label className="text-sm sm:col-span-2">Inspection date<input required type="date" className={control} value={due} onChange={e => setDue(e.target.value)} /></label>
      <label className="text-sm">Checkout (optional, South Africa time)<input type="datetime-local" className={control} value={checkout} onChange={e => setCheckout(e.target.value)} /></label>
      <label className="text-sm">Next arrival (optional, South Africa time)<input type="datetime-local" className={control} value={arrival} onChange={e => setArrival(e.target.value)} /></label>
      <button className={`${primary} sm:col-span-2`}>{pending ? 'Saving…' : 'Add to inspection work'}</button>
    </fieldset>
    <p role="status" className="mt-3 text-sm text-slate-700">{message}</p>
    {saved && <Link className="inline-flex min-h-11 items-center text-sm underline" href="/dashboard/work?scope=all">View all staff &amp; unassigned</Link>}
  </form>
}

export function InspectionJobCard({ job, property, manager, today }: { job: TurnoverJob; property: Allocation; manager: boolean; today: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState('')
  const [due, setDue] = useState(job.due_on)
  const state = jobState(job, today)
  const submitted = state === 'submitted'
  return <article className="h-full rounded-2xl border border-slate-200 bg-white p-5">
    <p className={`text-sm font-medium ${state === 'overdue' ? 'text-rose-700' : 'text-slate-600'}`}>{state === 'submitted' ? 'Inspection complete' : state === 'cancelled' ? 'Cancelled' : state === 'needs_attention' ? 'Pack unavailable · Needs attention' : `${state === 'overdue' ? 'Overdue · ' : ''}${dayLabel(job.due_on)}`}</p>
    <h2 className="mt-2 text-lg font-semibold">{propertyLabel(property)}</h2>
    <p className="mt-1 text-sm text-slate-600">Primary inspector: {property.inspector_id ? property.inspector_name ?? 'Unnamed team member' : 'Unassigned'}{property.inspector_id && !property.inspector_active ? ' (unavailable)' : ''}</p>
    <dl className="my-4 space-y-1 text-sm text-slate-600">
      {job.checkout_at && <div><dt className="inline">Checkout: </dt><dd className="inline">{formatDateTimeSAST(job.checkout_at)}</dd></div>}
      {job.next_arrival_at && <div><dt className="inline">Next arrival: </dt><dd className="inline">{formatDateTimeSAST(job.next_arrival_at)}</dd></div>}
      {job.pack_id && <div><dt className="inline">Started by: </dt><dd className="inline">{job.starter_name ?? 'Team member'}</dd></div>}
      {submitted && <div><dt className="inline">Submitted by: </dt><dd className="inline">{job.submitter_name ?? 'Team member'} · {formatDateTimeSAST(job.submitted_at)}</dd></div>}
    </dl>
    {submitted && <p className="mb-3 text-sm text-slate-600">Outstanding issues and guest readiness are tracked separately.</p>}
    <div className="flex flex-wrap items-center gap-3">
      {submitted && <Link href={`/properties/${property.id}/packs/${job.pack_id}/report`} className={primary}>View pack</Link>}
      {!submitted && state !== 'cancelled' && !job.pack_deleted && <InspectionStartButton jobId={job.id} propertyId={property.id} label={job.pack_id ? 'Continue inspection' : 'Start inspection'} />}
      <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/properties/${property.id}`}>Open apartment</Link>
    </div>
    <p role="status" className="mt-2 text-sm text-rose-700">{message}</p>
    {job.pack_deleted && !job.cancelled_at && <p className="mt-3 text-sm text-amber-900">The draft was discarded. {manager ? 'Cancel this inspection to clear it and allow a replacement.' : 'Ask a manager to cancel this inspection before scheduling a replacement.'}</p>}
    {manager && job.pack_deleted && !job.cancelled_at && <CancelInspectionControl job={job} propertyName={propertyLabel(property)} disabled={pending} />}
    {manager && !job.pack_id && !job.cancelled_at && <details className="mt-3 border-t border-slate-100 pt-3"><summary className="min-h-11 cursor-pointer text-sm">Change schedule</summary>
      <form onSubmit={e => { e.preventDefault(); start(async () => {
        const result = await updateTurnover(job.id, job.revision, due, false)
        setMessage(result.ok ? 'Schedule updated.' : result.error)
        if (result.ok) router.refresh()
      }) }}><fieldset disabled={pending} className="space-y-3"><label className="block text-sm">Inspection date<input required type="date" className={control} value={due} onChange={e => setDue(e.target.value)} /></label><p className="text-xs text-slate-600">Only the inspection date changes. Checkout and next arrival stay as recorded.</p><div className="flex items-center justify-between gap-3"><button className={primary}>Save date</button><CancelInspectionControl job={job} propertyName={propertyLabel(property)} disabled={pending} /></div></fieldset></form>
    </details>}
  </article>
}
