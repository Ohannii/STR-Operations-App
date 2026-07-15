import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
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
import { NewFlagForm } from './new-flag-form'

/**
 * GET /properties/[id]/flags/new
 *
 * Raise-flag form. Default category comes from ?category= query
 * (set by the Action Centre quick-add tiles). User can re-pick if
 * they tapped the wrong tile.
 *
 * Slice 11B-2: photos are now mandatory. The interactive capture +
 * submit lives in the NewFlagForm client component, which finalises
 * the flag together with its photos (finalizeFlagWithPhotos).
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

          <NewFlagForm
            propertyId={property.id}
            categories={reportableCategories.map((c) => ({
              key: c.key,
              label: c.label,
            }))}
            initialKey={initialKey}
            initialSeverity={initialSeverity}
            accountabilityOptions={CHARGEABLE_PARTIES.map((a) => ({
              value: a,
              label: chargeablePartyDisplay(a).label,
            }))}
            defaultAccountability={DEFAULT_ACCOUNTABILITY}
            cancelHref={`/properties/${property.id}`}
          />
        </div>
      </Card>
    </AppShell>
  )
}
