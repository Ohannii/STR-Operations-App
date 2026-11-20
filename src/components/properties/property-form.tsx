'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonClasses } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import type { PropertyFields, PropertyFormState } from '@/lib/properties/property-management'

export function PropertyForm({ action, initial, cancelHref, editing = false }: {
  action: (state: PropertyFormState, form: FormData) => Promise<PropertyFormState>
  initial?: PropertyFields
  cancelHref: string
  editing?: boolean
}) {
  const [state, formAction, pending] = useActionState(action, {})
  // Controlled fields keep every entry when a save fails or an edit is stale.
  const [values, setValues] = useState({
    name: initial?.name ?? '', address: initial?.address ?? '',
    unit_reference: initial?.unit_reference ?? '',
    bedrooms: initial?.bedrooms?.toString() ?? '', notes: initial?.notes ?? '',
  })
  const change = (key: keyof typeof values, value: string) => setValues(v => ({ ...v, [key]: value }))
  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <fieldset disabled={pending} className="space-y-5">
        <Field label="Property name" required htmlFor="property-name" hint="Include the estate when unit numbers repeat.">
          <Input id="property-name" name="name" required maxLength={200} value={values.name}
            onChange={e => change('name', e.target.value)} placeholder="e.g. Ballito Village · Unit 91" />
        </Field>
        <Field label="Address" htmlFor="property-address" hint="Estate, street and town.">
          <Input id="property-address" name="address" maxLength={500} value={values.address}
            onChange={e => change('address', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Unit reference" htmlFor="property-unit">
            <Input id="property-unit" name="unit_reference" maxLength={100} value={values.unit_reference}
              onChange={e => change('unit_reference', e.target.value)} placeholder="e.g. 91" />
          </Field>
          <Field label="Bedrooms" htmlFor="property-bedrooms">
            <Input id="property-bedrooms" name="bedrooms" type="number" min={0} max={50} step={1}
              value={values.bedrooms} onChange={e => change('bedrooms', e.target.value)} />
          </Field>
        </div>
        <Field label="Property notes" htmlFor="property-notes" hint="Visible to your team.">
          <textarea id="property-notes" name="notes" rows={4} maxLength={5000} value={values.notes}
            onChange={e => change('notes', e.target.value)}
            className="block w-full rounded-md border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50" />
        </Field>
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
          <Link href={cancelHref} className={buttonClasses('secondary')} aria-disabled={pending}
            tabIndex={pending ? -1 : undefined} onClick={e => { if (pending) e.preventDefault() }}>Cancel</Link>
          <Button type="submit">{pending ? 'Saving…' : editing ? 'Save changes' : 'Add property'}</Button>
        </div>
      </fieldset>
    </form>
  )
}
