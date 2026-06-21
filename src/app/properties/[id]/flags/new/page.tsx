import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, ChevronDown, Info } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, Label } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  getFlagCategoryDisplay,
  listReportableCategoryDisplays,
  type FlagCategoryKey,
  type FlagSeverity,
} from '@/lib/ui/flag-category'
import {
  CHARGEABLE_PARTIES,
  DEFAULT_ACCOUNTABILITY,
  chargeablePartyDisplay,
} from '@/lib/ui/flag-status'
import { createFlagAction } from './actions'

/**
 * GET /properties/[id]/flags/new
 *
 * Raise-flag form. Default category comes from ?category= query
 * (set by the Action Centre quick-add tiles). User can re-pick if
 * they tapped the wrong tile.
 *
 * Photo capture is intentionally deferred to the Evidence Camera
 * Mode session — the inline note in the form explains this rather
 * than showing a broken / disabled upload field.
 */
export default async function NewFlagPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ category?: string; error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id } = await params
  const { category: categoryParam, error } = await searchParams

  const supabase = await createClient()
  const { data: property, error: propertyErr } = await supabase
    .from('properties')
    .select('id, name, address, unit_reference')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (propertyErr) {
    // Diagnostic logging for the "Raise flag goes to 404" reports.
    // RLS denial / network error / stale session all surface here
    // as a query error rather than a null row. Without the log
    // the user just sees a generic 404.
    console.error('[flag/new] property lookup error:', propertyErr, 'id=', id)
  }
  if (!property) {
    console.error('[flag/new] property not found for id=', id, '— rendering 404')
    notFound()
  }

  const reportableCategories = listReportableCategoryDisplays()
  const reportableKeys = reportableCategories.map((c) => c.key)
  const defaultCategory = categoryParam
    ? getFlagCategoryDisplay(categoryParam)
    : undefined
  // Only prefill from the query param if it is a field-reportable category;
  // accountability/disposition keys (e.g. a stale guest_damage link) fall
  // back to the first reportable category.
  const initialKey: FlagCategoryKey =
    defaultCategory && reportableKeys.includes(defaultCategory.key)
      ? defaultCategory.key
      : 'maintenance_issue'
  const initialSeverity: FlagSeverity = defaultCategory?.severityDefault ?? 'med'

  // Session 9A Slice 1: non-blocking duplicate hint. When a category is
  // preselected, surface any OPEN report of the same category on this
  // property so the user can add to it instead of duplicating
  // (flag-as-parent). Hint only — never blocks a new report. No date
  // window: keeps this a pure server read (no Date.now() in render) and
  // an open report is worth surfacing regardless of age.
  let duplicateHintCount = 0
  if (defaultCategory && reportableKeys.includes(defaultCategory.key)) {
    const { data: catRow } = await supabase
      .from('flag_categories')
      .select('id')
      .eq('key', defaultCategory.key)
      .is('company_id', null)
      .maybeSingle<{ id: string }>()
    if (catRow) {
      const { count } = await supabase
        .from('flags')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', id)
        .eq('flag_category_id', catRow.id)
        .not('status', 'in', '(closed,no_action)')
        .is('deleted_at', null)
      duplicateHintCount = count ?? 0
    }
  }

  const sub = [property.unit_reference, property.address].filter(Boolean).join(' · ')

  return (
    <AppShell
      companyName={ctx.company.name}
      userName={ctx.profile?.full_name ?? 'Account'}
      userEmail={ctx.user.email ?? ''}
    >
      <Link
        href={`/properties/${property.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-5 transition-colors"
      >
        <ArrowLeft size={14} aria-hidden />
        Back to {property.name}
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Report an issue
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          On <span className="font-medium text-slate-900">{property.name}</span>
          {sub ? <span className="text-slate-500"> &middot; {sub}</span> : null}
        </p>
      </div>

      <Card className="max-w-2xl">
        <div className="p-6 sm:p-7">
          {duplicateHintCount > 0 ? (
            <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              There may already be {duplicateHintCount} open{' '}
              {duplicateHintCount === 1 ? 'report' : 'reports'} of this type on
              this apartment.{' '}
              <Link
                href={`/properties/${property.id}`}
                className="font-medium underline"
              >
                View open issues
              </Link>{' '}
              — add to an existing one if it&rsquo;s the same problem, or continue
              below to report a new one.
            </div>
          ) : null}
          {error ? (
            <div className="mb-5">
              <Alert tone="error">{decodeURIComponent(error)}</Alert>
            </div>
          ) : null}

          <form action={createFlagAction} className="space-y-5">
            <input type="hidden" name="property_id" value={property.id} />

            <Field
              label="Flag type"
              required
              htmlFor="category_key"
              hint="Pick the closest fit. Triage can re-classify later."
            >
              {/* appearance-none + our own chevron: iOS Safari renders
                  the *native* <select> control a few px wider than its
                  CSS box, which pushed the page just past the viewport
                  (a slight horizontal slide, eased by zooming out). This
                  is the only native dropdown in the flag flow — the flag
                  detail page uses radio chips, which is why it never
                  slid. appearance-none makes the select obey its box. */}
              <div className="relative">
                <select
                  id="category_key"
                  name="category_key"
                  defaultValue={initialKey}
                  className="block w-full h-10 pl-3 pr-9 text-sm text-slate-900 appearance-none border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                >
                  {reportableCategories.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={16}
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                />
              </div>
            </Field>

            <fieldset>
              <Label htmlFor="severity">
                Severity <span className="text-red-600 ml-0.5">*</span>
              </Label>
              <div className="flex gap-2">
                <SeverityChip value="low" label="Low" defaultChecked={initialSeverity === 'low'} />
                <SeverityChip value="med" label="Medium" defaultChecked={initialSeverity === 'med'} />
                <SeverityChip value="high" label="High" defaultChecked={initialSeverity === 'high'} />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                Default seeded from the flag type. Change if needed.
              </p>
            </fieldset>

            <Field
              label="Description"
              required
              htmlFor="description"
              hint="What did you notice? Plain language is fine."
            >
              <textarea
                id="description"
                name="description"
                required
                maxLength={1000}
                rows={4}
                placeholder="e.g. Cracked tile near bathroom door, about 10cm long. Looks recent."
                className="block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 resize-y min-h-[5rem]"
              />
            </Field>

            {/* Optional, low-prominence accountability. Per the Slice 1
                spec, who-may-pay is a separate dimension from the issue
                category: skippable, defaulting to "Not sure / needs triage",
                and confirmed by a manager in triage. (Role-based hiding for
                cleaners lands with role enforcement; until then it shows but
                is clearly optional.) */}
            <Field
              label="Who may be responsible?"
              htmlFor="chargeable_party_decision"
              hint="Optional — leave on “Not sure” if you can’t tell. A manager confirms this in triage."
            >
              <div className="relative">
                <select
                  id="chargeable_party_decision"
                  name="chargeable_party_decision"
                  defaultValue={DEFAULT_ACCOUNTABILITY}
                  className="block w-full h-10 pl-3 pr-9 text-sm text-slate-900 appearance-none border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                >
                  {CHARGEABLE_PARTIES.map((a) => (
                    <option key={a} value={a}>
                      {chargeablePartyDisplay(a).label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={16}
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                />
              </div>
            </Field>

            <div className="rounded-md border border-dashed border-slate-300 p-3 flex items-start gap-2.5 bg-slate-50/60">
              <Info size={14} className="text-slate-400 mt-0.5 shrink-0" aria-hidden />
              <div className="text-xs text-slate-600 leading-relaxed">
                <span className="font-medium text-slate-900">Photos:</span> the
                Evidence Camera (multi-capture, photo strip, optional notes per
                photo) ships in the next session after this. You&rsquo;ll be able to
                add photos to this flag retroactively when it&rsquo;s live.
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
              <Link href={`/properties/${property.id}`}>
                <Button variant="secondary" type="button">
                  Cancel
                </Button>
              </Link>
              <Button type="submit">Report issue</Button>
            </div>
          </form>
        </div>
      </Card>
    </AppShell>
  )
}

function SeverityChip({
  value,
  label,
  defaultChecked,
}: {
  value: 'low' | 'med' | 'high'
  label: string
  defaultChecked?: boolean
}) {
  return (
    <label className="cursor-pointer select-none">
      <input
        type="radio"
        name="severity"
        value={value}
        defaultChecked={defaultChecked}
        className="peer sr-only"
      />
      <span className="inline-block px-3.5 py-1.5 text-sm font-medium rounded-md border border-slate-300 bg-white text-slate-700 hover:border-slate-400 peer-checked:bg-slate-900 peer-checked:text-white peer-checked:border-slate-900 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900 peer-focus-visible:ring-offset-2 transition-colors">
        {label}
      </span>
    </label>
  )
}
