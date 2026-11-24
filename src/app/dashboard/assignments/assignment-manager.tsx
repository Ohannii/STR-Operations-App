'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { assignInspectors, setReassignmentPolicy } from '../work/actions'
import { classifyEstate, ESTATE_LABEL, naturalCompare } from '@/lib/properties/finder'
import { propertyLabel, type InspectionWorkspace } from '@/lib/inspections/workboard'
import { formatDateTimeSAST } from '@/lib/ui/datetime'

const control = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base'
export function AssignmentManager({ workspace, manager }: { workspace: InspectionWorkspace; manager: boolean }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [estate, setEstate] = useState('all')
  const [assignee, setAssignee] = useState('all')
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState('')
  const [message, setMessage] = useState('')
  const [pending, start] = useTransition()
  const editable = manager || !workspace.managers_only
  const filtered = useMemo(() => workspace.properties.filter(p =>
    (estate === 'all' || classifyEstate(p) === estate)
    && (assignee === 'all' || (assignee === 'unassigned' ? !p.inspector_id : p.inspector_id === assignee))
    && `${propertyLabel(p)} ${p.unit_reference ?? ''} ${p.inspector_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => naturalCompare(propertyLabel(a), propertyLabel(b))), [workspace.properties, estate, assignee, query])
  const chooseFilter = (change: () => void) => { change(); setSelected([]); setMessage('') }
  return <div className="space-y-5">
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="font-medium">{workspace.properties.filter(p => !p.inspector_id).length} unassigned apartments</p>
      <p className="mt-1 text-sm text-slate-600">{workspace.managers_only ? 'Only operations managers can change allocations.' : 'Inspectors and operations managers can change allocations.'}</p>
      {manager && <button disabled={pending} className="mt-3 min-h-11 text-sm font-medium underline" onClick={() => start(async () => {
        const result = await setReassignmentPolicy(!workspace.managers_only, workspace.settings_revision)
        setMessage(result.ok ? 'Reassignment setting saved.' : result.error)
        if (result.ok) router.refresh()
      })}>{workspace.managers_only ? 'Allow inspectors to reassign apartments' : 'Limit reassignment to managers'}</button>}
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Find an apartment or inspector<input disabled={pending} className={control} value={query} onChange={e => chooseFilter(() => setQuery(e.target.value))} placeholder="Estate, unit or name" /></label>
      <label className="text-sm">Estate<select disabled={pending} className={control} value={estate} onChange={e => chooseFilter(() => setEstate(e.target.value))}><option value="all">All estates</option>{Object.entries(ESTATE_LABEL).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label className="text-sm">Current allocation<select disabled={pending} className={control} value={assignee} onChange={e => chooseFilter(() => setAssignee(e.target.value))}><option value="all">Everyone</option><option value="unassigned">Unassigned</option>{workspace.inspectors.map(i => <option key={i.id} value={i.id}>{i.name ?? 'Unnamed team member'}</option>)}</select></label>
    </div>
    {editable && <div className="sticky top-14 z-10 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="mb-2 text-sm font-medium">{selected.length} selected</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select aria-label="Assign selected apartments to" disabled={pending} className={control} value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose inspector…</option><option value="unassigned">Leave unassigned</option>{workspace.inspectors.map(i => <option key={i.id} value={i.id}>{i.name ?? 'Unnamed team member'}</option>)}</select>
        <button disabled={pending || !target || !selected.length} className="min-h-12 shrink-0 rounded-xl bg-slate-900 px-5 text-white disabled:opacity-40" onClick={() => start(async () => {
          const changes = workspace.properties.filter(p => selected.includes(p.id)).map(p => ({ property_id: p.id, revision: p.revision }))
          const result = await assignInspectors(changes, target === 'unassigned' ? null : target)
          setMessage(result.ok ? 'Inspector allocations saved.' : result.error)
          if (result.ok) { setSelected([]); router.refresh() }
        })}>{pending ? 'Saving…' : 'Save allocation'}</button>
      </div>
    </div>}
    <p role="status" aria-live="polite" className="text-sm text-slate-700">{message}</p>
    {editable && filtered.length > 0 && <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={pending} checked={filtered.every(p => selected.includes(p.id))} onChange={e => setSelected(e.target.checked ? filtered.map(p => p.id) : [])} className="size-5" />Select all {filtered.length} shown</label>}
    <ul className="grid gap-3 sm:grid-cols-2">{filtered.map(p => <li key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
      <label className="flex items-start gap-3">{editable && <input disabled={pending} type="checkbox" aria-label={`Select ${propertyLabel(p)}`} checked={selected.includes(p.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} className="mt-1 size-5 shrink-0" />}
        <span><span className="block font-medium">{propertyLabel(p)}</span><span className="mt-1 block text-sm text-slate-600">{p.inspector_id ? `${p.inspector_name ?? 'Unnamed team member'}${p.inspector_active ? '' : ' · Unavailable; reassign'}` : 'Unassigned'}</span></span>
      </label>
      <Link href={`/properties/${p.id}`} className="mt-2 inline-flex min-h-11 items-center text-sm underline">Open apartment</Link>
    </li>)}</ul>
    {!filtered.length && <p className="rounded-xl border border-dashed border-slate-300 p-6 text-slate-600">No apartments match these filters.</p>}
    <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="min-h-11 cursor-pointer font-medium">Recent allocation changes</summary><ul className="divide-y divide-slate-100">{workspace.history.map(h => <li key={h.id} className="py-3 text-sm"><p className="font-medium">{workspace.properties.find(p => p.id === h.property_id) ? propertyLabel(workspace.properties.find(p => p.id === h.property_id)!) : 'Apartment'}</p><p>{h.previous ?? (h.previous_id ? 'Unnamed team member' : 'Unassigned')} → {h.next ?? (h.next_id ? 'Unnamed team member' : 'Unassigned')}</p><p className="text-slate-600">{h.actor ?? 'Team member'} · {formatDateTimeSAST(h.at)}</p></li>)}</ul>{!workspace.history.length && <p className="py-3 text-sm text-slate-600">No allocation changes yet.</p>}</details>
  </div>
}
