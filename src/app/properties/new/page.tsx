import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Building2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createPropertyAction } from './actions'

/**
 * GET /properties/new
 *
 * Minimal property creation form. Required: name. Optional: address,
 * unit reference, bedrooms. Status defaults to 'idle' (per the
 * properties table default in core_schema.sql).
 */
export default async function NewPropertyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { error } = await searchParams

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-6 transition-colors"
        >
          <ArrowLeft size={14} aria-hidden />
          Back to dashboard
        </Link>

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-lg bg-slate-900">
            <Building2 size={20} className="text-white" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
              Add a property
            </h1>
            <p className="text-sm text-slate-600 mt-0.5">
              New apartment for{' '}
              <span className="font-medium text-slate-900">{ctx.company.name}</span>.
            </p>
          </div>
        </div>

        <Card>
          <div className="p-6 sm:p-7">
            {error ? (
              <div className="mb-5">
                <Alert tone="error">{decodeURIComponent(error)}</Alert>
              </div>
            ) : null}

            <form action={createPropertyAction} className="space-y-5">
              <Field
                label="Property name"
                required
                htmlFor="name"
                hint="Shown across the dashboard and on owner reports."
              >
                <Input
                  id="name"
                  name="name"
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Sea Point Apt 12"
                />
              </Field>

              <Field
                label="Address"
                htmlFor="address"
                hint="Street, suburb, city. Optional but recommended."
              >
                <Input
                  id="address"
                  name="address"
                  type="text"
                  placeholder="42 Beach Road, Sea Point, Cape Town"
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Unit reference" htmlFor="unit_reference">
                  <Input
                    id="unit_reference"
                    name="unit_reference"
                    type="text"
                    placeholder="Apt 12"
                  />
                </Field>
                <Field label="Bedrooms" htmlFor="bedrooms">
                  <Input
                    id="bedrooms"
                    name="bedrooms"
                    type="number"
                    min={0}
                    max={50}
                    step={1}
                    placeholder="2"
                  />
                </Field>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <Link href="/dashboard">
                  <Button variant="secondary" type="button">
                    Cancel
                  </Button>
                </Link>
                <Button type="submit">Add property</Button>
              </div>
            </form>
          </div>
        </Card>

        <p className="mt-5 text-xs text-slate-500 leading-relaxed">
          Status defaults to <span className="font-mono text-slate-700">idle</span>.
          Inspections, flags, and other state will move it through{' '}
          <span className="font-mono text-slate-700">guest_in</span>,{' '}
          <span className="font-mono text-slate-700">needs_attention</span>, and the
          rest of the v1.0 state machine as workflows ship.
        </p>
      </div>
    </div>
  )
}
