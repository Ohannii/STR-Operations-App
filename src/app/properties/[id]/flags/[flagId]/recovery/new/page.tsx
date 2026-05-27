import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, MessageCircle } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { getFlagCategoryDisplay } from '@/lib/ui/flag-category'
import { createRecoveryTaskAction } from './actions'

/**
 * GET /properties/[id]/flags/[flagId]/recovery/new
 *
 * Captures the minimum info the WhatsApp template + audit trail
 * need: guest first name, guest phone, optional email, estimated
 * amount, deadline (hours), and an optional short description.
 *
 * The form posts to create_recovery_task_from_flag (SECURITY
 * DEFINER RPC) which atomically creates a minimal stays row plus
 * the guest_recovery_tasks row, and defaults the flag's
 * chargeable_party_decision to 'guest' if it wasn't set.
 */
type FlagCategoryRel = { id: string; key: string } | { id: string; key: string }[] | null

type FlagSummary = {
  id: string
  description: string | null
  flag_category: FlagCategoryRel
}

function pickEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export default async function NewRecoveryTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; flagId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId, flagId } = await params
  const { error } = await searchParams

  const supabase = await createClient()

  const propertyPromise = supabase
    .from('properties')
    .select('id, name')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; name: string }>()

  const flagPromise = supabase
    .from('flags')
    .select(`
      id,
      description,
      flag_category:flag_categories (id, key)
    `)
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<FlagSummary>()

  const [{ data: property }, { data: flag }] = await Promise.all([propertyPromise, flagPromise])

  if (!property || !flag) notFound()

  const categoryRow = pickEmbedded(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined

  // Pre-fill the description with the flag's text -- helpful for the
  // WhatsApp message later. User can edit / blank it.
  const initialDescription = flag.description ?? ''

  return (
    <AppShell
      companyName={ctx.company.name}
      userName={ctx.profile?.full_name ?? 'Account'}
      userEmail={ctx.user.email ?? ''}
    >
      <Link
        href={`/properties/${property.id}/flags/${flag.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-5 transition-colors"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to flag
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-lg bg-slate-900">
          <MessageCircle size={20} className="text-white" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Start recovery tracking
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            For WhatsApp follow-up or paid/refused tracking on the flag{' '}
            <span className="font-medium text-slate-900">{cat?.label ?? 'Flag'}</span>{' '}
            in <span className="font-medium text-slate-900">{property.name}</span>.
          </p>
        </div>
      </div>

      <Card className="max-w-2xl">
        <div className="p-6 sm:p-7">
          {error ? (
            <div className="mb-5">
              <Alert tone="error">{decodeURIComponent(error)}</Alert>
            </div>
          ) : null}

          <form action={createRecoveryTaskAction} className="space-y-5">
            <input type="hidden" name="property_id" value={property.id} />
            <input type="hidden" name="flag_id" value={flag.id} />

            <Field
              label="Guest first name"
              required
              htmlFor="guest_first_name"
              hint="Used in the WhatsApp message greeting."
            >
              <Input
                id="guest_first_name"
                name="guest_first_name"
                type="text"
                required
                autoFocus
                placeholder="e.g. Anil"
              />
            </Field>

            <Field
              label="Guest phone (WhatsApp)"
              required
              htmlFor="guest_phone"
              hint="Include the country code (e.g. +27 for South Africa)."
            >
              <Input
                id="guest_phone"
                name="guest_phone"
                type="tel"
                required
                inputMode="tel"
                placeholder="+27 82 555 1234"
              />
            </Field>

            <Field
              label="Guest email"
              htmlFor="guest_email"
              hint="Optional. Captured for the audit record."
            >
              <Input
                id="guest_email"
                name="guest_email"
                type="email"
                placeholder="guest@example.com"
              />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Estimated cost"
                htmlFor="estimated_amount"
                hint="ZAR. Optional but shown in the message."
              >
                {/*
                  step="any" avoids the HTML5 step-grid validation,
                  which combined with FP arithmetic in the browser
                  can quietly snap a typed "200" to "199.98".
                  Server-side rounds defensively as well.
                */}
                <Input
                  id="estimated_amount"
                  name="estimated_amount"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="2500.00"
                />
              </Field>
              <Field
                label="Deadline (hours)"
                htmlFor="deadline_hours"
                hint="Default 48. Max 720 (30 days)."
              >
                <Input
                  id="deadline_hours"
                  name="deadline_hours"
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  defaultValue={48}
                />
              </Field>
            </div>

            <Field
              label="Short description (incident)"
              htmlFor="description"
              hint="Used in the WhatsApp message body. Editable here."
            >
              <textarea
                id="description"
                name="description"
                rows={3}
                maxLength={500}
                defaultValue={initialDescription}
                placeholder="e.g. a cracked coffee machine"
                className="block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 resize-y min-h-[5rem]"
              />
            </Field>

            <div className="rounded-md border border-dashed border-slate-300 p-3 bg-slate-50/60 text-xs text-slate-600 leading-relaxed">
              <span className="font-medium text-slate-900">Note:</span> the message
              template will say evidence can be shared on request. Photo attachments
              ship with the Evidence Camera in the next session — we don&rsquo;t
              promise attachments we can&rsquo;t deliver yet.
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
              <Link href={`/properties/${property.id}/flags/${flag.id}`}>
                <Button variant="secondary" type="button">Cancel</Button>
              </Link>
              <Button type="submit">Start tracking</Button>
            </div>
          </form>
        </div>
      </Card>
    </AppShell>
  )
}
