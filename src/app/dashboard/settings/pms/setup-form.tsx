'use client'

import { useRef, useState } from 'react'
import { classifyEstate, ESTATE_LABEL } from '@/lib/properties/finder'
import type { HostawayListing, HostawayUnit } from '@/lib/pms/hostaway'
import type { PmsProperty, PmsResult, PmsSetup } from '@/lib/pms/setup-types'
import { connectHostaway, disconnectHostaway, loadHostawayListings, loadHostawayUnits, saveHostawayMapping } from './actions'

const field = 'mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base disabled:bg-slate-100'
const primary = 'inline-flex min-h-12 items-center justify-center rounded-xl bg-teal-700 px-5 font-semibold text-white disabled:opacity-50'
const secondary = 'inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-slate-800 disabled:opacity-50'
const apartment = (p: PmsProperty) => `${ESTATE_LABEL[classifyEstate(p)]} · ${p.name}${p.unit_reference ? ` · ${p.unit_reference}` : ''}`

export function PmsSetupForm({ initial }: { initial: PmsResult<PmsSetup> }) {
  const [setup, setSetup] = useState(initial.ok ? initial.data : null)
  const [accountId, setAccountId] = useState(initial.ok ? initial.data.connection?.account_id ?? '' : '')
  const [apiKey, setApiKey] = useState('')
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  const [busy, setBusy] = useState(false), flight = useRef(false)
  const [message, setMessage] = useState(''), [error, setError] = useState(initial.ok ? '' : initial.error)
  const [listings, setListings] = useState<HostawayListing[] | null>(null)
  const [listingId, setListingId] = useState(''), [units, setUnits] = useState<HostawayUnit[] | null>(null)
  const [unitId, setUnitId] = useState(''), [propertyId, setPropertyId] = useState('')
  const [physical, setPhysical] = useState(false), [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const connection = setup?.connection
  const connected = connection?.status === 'connected' && !!connection.credential_expires_at && Date.parse(connection.credential_expires_at) > checkedAt

  async function perform<T>(action: () => Promise<PmsResult<T>>, confirmed: (data: T) => void) {
    if (flight.current) return
    flight.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await action()
      if (result.ok) confirmed(result.data)
      else setError(result.error)
    } catch { setError('Could not confirm the latest setup. Reload this page before retrying.') }
    finally { flight.current = false; setBusy(false); setCheckedAt(Date.now()) }
  }
  function resetDiscovery() { setListings(null); setListingId(''); setUnits(null); setUnitId(''); setPropertyId(''); setPhysical(false) }
  const sourceUnit = units?.length === 0 ? '0' : unitId
  const mapping = setup?.mappings.find(m => m.listing_id === listingId && m.unit_id === sourceUnit)

  return <div className="mt-6 max-w-3xl space-y-6 pb-12">
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-teal-950">{message}</p>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="connection-heading">
      <h2 id="connection-heading" className="text-xl font-semibold">1. Connect Hostaway</h2>
      <p className="mt-2 text-slate-600">Use your company’s Hostaway API details. Only company admins can manage this connection. Your API key is used once to request a securely stored access token.</p>
      {connection && <p className="mt-3 font-medium text-teal-900">{connected ? 'Account connected' : connection.status === 'disconnected' ? 'Disconnected' : 'Reconnect required'} · Account {connection.account_id}</p>}
      <form className="mt-5" onSubmit={event => {
        event.preventDefault()
        void perform(() => connectHostaway({ accountId, apiKey, revision: connection?.revision ?? 0 }), data => {
          setSetup(data); setApiKey(''); resetDiscovery(); setMessage('Hostaway connection verified. Next, match the listings to your apartments.')
        })
      }}>
        <fieldset disabled={busy || !setup} className="space-y-4">
          <label className="block font-medium">Account ID
            <input name="accountId" inputMode="numeric" required maxLength={18} value={accountId} readOnly={!!connection}
              onChange={e => { if (!flight.current) setAccountId(e.target.value) }} className={field} autoComplete="off" />
          </label>
          <label className="block font-medium">Hostaway API key
            <input name="apiKey" type="password" autoComplete="off" required maxLength={4096} value={apiKey}
              onChange={e => { if (!flight.current) setApiKey(e.target.value) }} className={field} aria-describedby="key-help" />
          </label>
          <p id="key-help" className="text-sm text-slate-600">Enter it here only. Don’t send the key in chat or email. Reconnecting keeps the existing apartment matches.</p>
          <button type="submit" className={`${primary} w-full sm:w-auto`}>{busy ? 'Please wait…' : connection ? 'Verify and reconnect' : 'Verify and connect'}</button>
        </fieldset>
      </form>
      {connected && <div className="mt-4 border-t border-slate-100 pt-3">
        {!confirmDisconnect ? <button type="button" disabled={busy} className="min-h-11 text-sm text-slate-600 underline" onClick={() => setConfirmDisconnect(true)}>Disconnect this account…</button>
          : <div className="space-y-3"><p>Disconnect this app from Hostaway? Apartment matches are kept. This does not revoke the token in Hostaway.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" autoFocus disabled={busy} className={secondary} onClick={() => setConfirmDisconnect(false)}>Keep connection</button>
              <button type="button" disabled={busy} className={secondary} onClick={() => void perform(() => disconnectHostaway(connection.revision), data => {
                setSetup(data); setConfirmDisconnect(false); resetDiscovery(); setMessage('Disconnected. Reconnect the same account when you are ready.')
              })}>Confirm disconnect</button>
            </div>
          </div>}
      </div>}
    </section>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby="mapping-heading">
      <h2 id="mapping-heading" className="text-xl font-semibold">2. Match your apartments</h2>
      <p className="mt-2 text-slate-600">Match the exact listing and physical subunit to an apartment already in this app. Ballito Life and Ballito Village can have the same unit number. Check the estate and apartment together.</p>
      <fieldset disabled={busy || !connected} className="mt-5 space-y-4">
        <button type="button" className={secondary} onClick={() => void perform(() => loadHostawayListings(connection!.revision), data => {
          setListings(data); setListingId(''); setUnits(null); setUnitId(''); setPropertyId(''); setPhysical(false)
          if (!data.length) setMessage('Hostaway returned no listings for this account.')
        })}>{listings ? 'Reload Hostaway listings' : 'Load Hostaway listings'}</button>
        {listings && listings.length > 0 && <label className="block font-medium">Hostaway listing
          <select value={listingId} className={field} onChange={e => {
            if (flight.current) return
            const selected = e.target.value
            setListingId(selected); setUnits(null); setUnitId(''); setPropertyId(''); setPhysical(false)
            if (selected) void perform(() => loadHostawayUnits({ listingId: selected, revision: connection!.revision }), setUnits)
          }}><option value="">Choose the exact listing…</option>{listings.map(l => <option key={l.id} value={l.id}>{l.name} · ID {l.id}</option>)}</select>
        </label>}
        {listingId && units === null && !busy && <button type="button" className={secondary} onClick={() => void perform(() => loadHostawayUnits({ listingId, revision: connection!.revision }), setUnits)}>Retry loading physical units</button>}
        {units && units.length > 0 && <label className="block font-medium">Physical Hostaway subunit
          <select value={unitId} className={field} onChange={e => { if (!flight.current) { setUnitId(e.target.value); setPropertyId('') } }}>
            <option value="">Choose the physical subunit…</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}{u.unitNumber ? ` · ${u.unitNumber}` : ''} · ID {u.id}</option>)}
          </select>
        </label>}
        {units?.length === 0 && <label className="flex min-h-12 items-start gap-3 rounded-xl bg-slate-50 p-3">
          <input type="checkbox" className="mt-1 size-5 shrink-0 accent-teal-700" checked={physical} onChange={e => { if (!flight.current) setPhysical(e.target.checked) }} />
          <span>Hostaway returned no subunits. I have checked that this listing represents one physical apartment.</span>
        </label>}
        {units && (units.length === 0 ? physical : !!unitId) && <>
          {mapping && <p className="text-sm text-slate-600">Already matched to {apartment(setup!.properties.find(p => p.id === mapping.property_id) ?? { id: mapping.property_id, name: 'Unavailable apartment', address: null, unit_reference: null })}. Saving changes this match.</p>}
          <label className="block font-medium">Existing apartment in this company
            <select className={field} value={propertyId} onChange={e => { if (!flight.current) setPropertyId(e.target.value) }}>
              <option value="">Choose estate and apartment…</option>{setup?.properties.map(p => <option key={p.id} value={p.id}>{apartment(p)}</option>)}
            </select>
          </label>
          <button type="button" disabled={!propertyId} className={`${primary} w-full sm:w-auto`} onClick={() => void perform(() => saveHostawayMapping({
            listingId, unitId: sourceUnit!, propertyId, connectionRevision: connection!.revision, mappingRevision: mapping?.revision ?? 0, physicalListingConfirmed: physical,
          }), data => { setSetup(data); setMessage('Apartment match saved. Checkout syncing is not enabled yet.') })}>Save apartment match</button>
        </>}
      </fieldset>
      {!connected && <p className="mt-4 text-sm text-slate-600">Connect the account first to verify its listings.</p>}
      {!!setup?.mappings.length && <div className="mt-6 border-t border-slate-200 pt-4">
        <h3 className="font-semibold">Verified matches ({setup.mappings.length})</h3>
        <ul className="mt-2 divide-y divide-slate-100">{setup.mappings.map(m => <li key={m.id} className="py-3">
          <p className="font-medium">{setup.properties.find(p => p.id === m.property_id) ? apartment(setup.properties.find(p => p.id === m.property_id)!) : 'Apartment unavailable'}</p>
          <p className="mt-1 text-sm text-slate-600">{m.listing_name}{m.unit_name ? ` / ${m.unit_name}` : ''} · Listing {m.listing_id}{m.unit_id !== '0' ? ` · Subunit ${m.unit_id}` : ''}</p>
          {!m.time_zone && <p className="mt-1 text-sm text-amber-900">Hostaway time zone needs verification before checkout syncing.</p>}
        </li>)}</ul>
      </div>}
    </section>
    <p className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-950"><strong>Checkout syncing is not enabled yet.</strong> This step verifies the connection and apartment matches. It does not create inspections, change bookings or contact guests.</p>
  </div>
}
