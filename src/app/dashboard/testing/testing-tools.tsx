'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { endTestMode, setPropertyTestStatus, startTestMode } from './actions'
import { TEST_SESSION_MINUTES, testSessionEndLabel, type ActiveTestSession } from '@/lib/testing/test-mode'

type Property = { id: string; name: string; address: string | null; unit_reference: string | null; is_test: boolean }
const field = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base'
const primary = 'min-h-12 rounded-xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2'
const secondary = 'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-700'
const label = (p: Property) => [p.name, p.address].filter(Boolean).join(' · ')
const minutesLabel = (m: number) => (m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`)

export function TestingTools({ session, properties }: { session: ActiveTestSession | null; properties: Property[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState('')
  const [sessionPropertyId, setSessionPropertyId] = useState('')
  const [minutes, setMinutes] = useState<number>(60)
  const [reason, setReason] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [propertyReason, setPropertyReason] = useState('')
  const run = (action: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) => start(async () => {
    const result = await action()
    setMessage(result.ok ? done : result.error ?? 'Could not save.')
    if (result.ok) { after?.(); router.refresh() }
  })
  const testApartments = properties.filter(p => p.is_test)
  const realApartments = properties.filter(p => !p.is_test)
  return <div className="mt-6 space-y-6">
    <p role="status" aria-live="polite" className="text-sm text-slate-700">{message}</p>

    <section aria-labelledby="test-mode-heading" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id="test-mode-heading" className="text-lg font-semibold">Test mode on one apartment</h2>
      <p className="mt-1 text-sm text-slate-600">For testing on a real apartment, such as Unit 13. While it is on, issues <strong>you</strong> report <strong>on that apartment</strong> go to the test Asana project. Your issues on any other apartment, and everyone else’s issues, go to the team as normal. It switches itself off.</p>
      {session ? <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 p-3">
        <p className="text-sm text-amber-950">On for <strong>{session.propertyName}</strong> until <strong>{testSessionEndLabel(session.endsAt)}</strong></p>
        <button type="button" disabled={pending} className={secondary} onClick={() => run(endTestMode, 'Test mode ended.')}>End test mode</button>
      </div> : <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); run(() => startTestMode({ propertyId: sessionPropertyId, minutes, reason }), 'Test mode is on.', () => setReason('')) }}>
        <fieldset disabled={pending} className="contents">
          <label className="text-sm">Apartment you are testing<select required className={field} value={sessionPropertyId} onChange={e => setSessionPropertyId(e.target.value)}><option value="">Choose…</option>{realApartments.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></label>
          <label className="text-sm">For<select className={field} value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{TEST_SESSION_MINUTES.map(m => <option key={m} value={m}>{minutesLabel(m)}</option>)}</select></label>
          <label className="text-sm sm:col-span-2">What are you testing?<input required minLength={3} maxLength={200} className={field} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Report issue flow" /></label>
          <button className={`${primary} sm:col-span-2 sm:w-fit`}>Turn on test mode</button>
        </fieldset>
      </form>}
    </section>

    <section aria-labelledby="test-apartments-heading" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 id="test-apartments-heading" className="text-lg font-semibold">Test apartments</h2>
      <p className="mt-1 text-sm text-slate-600">Every issue on a test apartment goes to the test Asana project, for everyone. Use this only for apartments that are not real, such as Test 1 and Test 2.</p>
      <ul className="mt-3 divide-y divide-slate-100">
        {testApartments.map(p => <TestApartmentRow key={p.id} property={p} pending={pending}
          onConfirm={(why) => run(() => setPropertyTestStatus({ propertyId: p.id, isTest: false, reason: why }), `${p.name} is a normal apartment again. New issues there go to the team.`)} />)}
        {!testApartments.length && <li className="py-2 text-sm text-slate-600">No test apartments yet.</li>}
      </ul>
      <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={e => { e.preventDefault(); run(() => setPropertyTestStatus({ propertyId, isTest: true, reason: propertyReason }), 'Test apartment saved.', () => { setPropertyId(''); setPropertyReason('') }) }}>
        <fieldset disabled={pending} className="contents">
          <label className="text-sm">Apartment<select required className={field} value={propertyId} onChange={e => setPropertyId(e.target.value)}><option value="">Choose…</option>{realApartments.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}</select></label>
          <label className="text-sm sm:col-span-2">Reason<input required minLength={3} maxLength={200} className={field} value={propertyReason} onChange={e => setPropertyReason(e.target.value)} placeholder="e.g. Training apartment, not a real unit" /></label>
          <button className={`${secondary} sm:col-span-3 sm:w-fit`}>Make test apartment</button>
        </fieldset>
      </form>
    </section>
  </div>
}

/** One test apartment with an in-app, accessible "make normal" confirmation (no browser prompt). */
function TestApartmentRow({ property, pending, onConfirm }: { property: Property; pending: boolean; onConfirm: (reason: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [why, setWhy] = useState('')
  const id = useId()
  return <li className="py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">{label(property)}</span>
      {!confirming && <button type="button" disabled={pending} className={secondary} onClick={() => setConfirming(true)}>Make normal…</button>}
    </div>
    {confirming && <form id={`${id}-confirm`} role="group" aria-labelledby={`${id}-title`} className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3"
      onSubmit={e => { e.preventDefault(); if (why.trim().length >= 3) onConfirm(why.trim()) }}>
      <p id={`${id}-title`} className="text-sm font-semibold text-amber-950">Make {property.name} a normal apartment?</p>
      <p className="mt-1 text-sm text-amber-950">From now on, new issues raised there will go to the team’s live Asana board. Issues already raised stay labelled as tests.</p>
      <label className="mt-3 block text-sm">Reason<input autoFocus required minLength={3} maxLength={200} className={field} value={why} onChange={e => setWhy(e.target.value)} placeholder="e.g. Training finished" /></label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={pending || why.trim().length < 3} className={primary}>Yes, make it normal</button>
        <button type="button" disabled={pending} className={secondary} onClick={() => { setConfirming(false); setWhy('') }}>Cancel</button>
      </div>
    </form>}
  </li>
}
