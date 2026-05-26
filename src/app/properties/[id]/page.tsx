import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  Camera,
  ChevronRight,
  ClipboardCheck,
  Flag,
  Info,
  Plus,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonClasses } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  getFlagCategoryDisplay,
  QUICK_ADD_KEYS,
  severityDisplay,
  type FlagCategoryKey,
} from '@/lib/ui/flag-category'
import { propertyStatusDisplay } from '@/lib/ui/property-status'
import { relativeTime } from '@/lib/ui/relative-time'

/**
 * GET /properties/[id]
 *
 * The Apartment Action Centre. Per docs/APARTMENT_ACTION_CENTRE.md
 * this is "the home screen that replaces Asana" — the per-property
 * workspace where field staff see what's going on and raise new
 * flags in one tap.
 *
 * Sections:
 *   1. Property header (name, address, unit, status badge, beds).
 *   2. Quick-add tiles — 6 single-tap flag types, prefilling the
 *      /flags/new form via ?category=.
 *   3. Open flags — read-only list of flags not yet closed/no_action.
 *      The triage/resolve UI ships in a later session.
 *   4. Inspection history — empty placeholder; ships with the
 *      turnover inspection workflow.
 *   5. Property metadata footer for context.
 */
export default async function PropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ raised?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id } = await params
  const { raised } = await searchParams

  const supabase = await createClient()

  // RLS scopes this to the user's company. If the property exists in
  // another company or doesn't exist at all, we get null and 404.
  const { data: property } = await supabase
    .from('properties')
    .select('id, name, address, unit_reference, status, bedrooms, notes, created_at')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!property) notFound()

  // Open flags = anything not in a terminal state.
  // Per FLAG_AND_ACTION_MODEL.md: 'raised' | 'classified' | 'actioned'
  // are active; 'closed' | 'no_action' are terminal.
  const { data: openFlags, error: flagsError } = await supabase
    .from('flags')
    .select('id, flag_category_id, status, severity, description, raised_at')
    .eq('property_id', property.id)
    .not('status', 'in', '(closed,no_action)')
    .is('deleted_at', null)
    .order('raised_at', { ascending: false })
    .limit(50)

  // Pull the category names for any flags we found. flag_categories
  // is publicly readable (system seeds). Tiny in-memory join.
  const categoryIds = Array.from(
    new Set((openFlags ?? []).map((f) => f.flag_category_id))
  )
  let categoryByKey: Record<string, { id: string; key: string }> = {}
  if (categoryIds.length > 0) {
    const { data: cats } = await supabase
      .from('flag_categories')
      .select('id, key')
      .in('id', categoryIds)
    if (cats) {
      categoryByKey = Object.fromEntries(cats.map((c) => [c.id, c]))
    }
  }

  const status = propertyStatusDisplay(property.status)
  const sub = [property.unit_reference, property.address].filter(Boolean).join(' · ')

  return (
    <AppShell
      companyName={ctx.company.name}
      userName={ctx.profile?.full_name ?? 'Account'}
      userEmail={ctx.user.email ?? ''}
    >
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-5 transition-colors"
      >
        <ArrowLeft size={14} aria-hidden />
        All properties
      </Link>

      {raised ? (
        <div className="mb-5">
          <Alert tone="success">Flag raised. It&rsquo;s in the Open flags list below.</Alert>
        </div>
      ) : null}

      {/* Property header */}
      <Card className="mb-8">
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Apartment
              </p>
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight truncate">
                {property.name}
              </h1>
              {sub ? (
                <p className="text-sm text-slate-600 mt-1">{sub}</p>
              ) : (
                <p className="text-sm text-slate-400 italic mt-1">No address recorded</p>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs text-slate-500">
                <span>
                  <span className="text-slate-700 font-medium">{property.bedrooms ?? '—'}</span>{' '}
                  {property.bedrooms === 1 ? 'bedroom' : 'bedrooms'}
                </span>
                <span>Added {relativeTime(property.created_at)}</span>
              </div>
            </div>
            <Badge tone={status.tone} className="!text-xs !px-2.5 !py-1">
              {status.label}
            </Badge>
          </div>
          {property.notes ? (
            <p className="mt-4 pt-4 border-t border-slate-100 text-sm text-slate-700">
              {property.notes}
            </p>
          ) : null}
        </div>
      </Card>

      {/* Quick-add tiles */}
      <section className="mb-10">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-900">Raise a flag</h2>
          <p className="text-sm text-slate-600">
            One tap to capture something an inspector or manager noticed. Triage and
            child actions ship in a later session.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {QUICK_ADD_KEYS.map((key) => {
            const cat = getFlagCategoryDisplay(key)
            if (!cat) return null
            const Icon = cat.icon
            const isSafety = key === 'safety_urgent'
            return (
              <Link
                key={key}
                href={`/properties/${property.id}/flags/new?category=${key}`}
                className={
                  isSafety
                    ? 'group bg-red-50 border border-red-200 rounded-xl p-4 hover:bg-red-100 hover:border-red-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2'
                    : 'group bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2'
                }
              >
                <div
                  className={
                    isSafety
                      ? 'w-9 h-9 rounded-lg bg-red-600 text-white flex items-center justify-center mb-2.5'
                      : 'w-9 h-9 rounded-lg bg-slate-100 text-slate-700 group-hover:bg-slate-900 group-hover:text-white flex items-center justify-center mb-2.5 transition-colors'
                  }
                >
                  <Icon size={18} aria-hidden />
                </div>
                <p
                  className={
                    isSafety
                      ? 'text-sm font-semibold text-red-900'
                      : 'text-sm font-semibold text-slate-900'
                  }
                >
                  {cat.label}
                </p>
                <p
                  className={
                    isSafety
                      ? 'text-[11px] text-red-700 mt-0.5 leading-snug'
                      : 'text-[11px] text-slate-500 mt-0.5 leading-snug'
                  }
                >
                  {key === 'guest_damage'
                    ? 'Most recent guest'
                    : key === 'inventory_missing'
                    ? 'Or item damaged'
                    : key === 'safety_urgent'
                    ? 'Same-day priority'
                    : cat.blurb.split(' ').slice(0, 5).join(' ')}
                </p>
              </Link>
            )
          })}
        </div>
      </section>

      {/* Open flags */}
      <section className="mb-10">
        <div className="flex items-end justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Open flags</h2>
            <p className="text-sm text-slate-600">
              {openFlags && openFlags.length > 0
                ? `${openFlags.length} open ${openFlags.length === 1 ? 'item' : 'items'} on this apartment.`
                : 'Nothing flagged on this apartment right now.'}
            </p>
          </div>
        </div>

        {flagsError ? (
          <Alert tone="error">
            <span className="font-medium">Could not load flags.</span> {flagsError.message}
          </Alert>
        ) : !openFlags || openFlags.length === 0 ? (
          <EmptyState
            icon={Flag}
            title="No open flags"
            description="Tap a tile above to raise the first one."
          />
        ) : (
          <ul className="space-y-2.5">
            {openFlags.map((flag) => {
              const categoryRow = categoryByKey[flag.flag_category_id]
              const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
              const Icon = cat?.icon ?? Flag
              const sev = severityDisplay(flag.severity)
              return (
                <Card key={flag.id}>
                  <div className="p-4 flex items-start gap-3">
                    <div
                      className={
                        cat?.tone === 'red'
                          ? 'shrink-0 w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center'
                          : 'shrink-0 w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center'
                      }
                    >
                      <Icon size={16} aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-slate-900">
                          {cat?.label ?? 'Flag'}
                        </span>
                        <Badge tone={sev.tone}>{sev.label}</Badge>
                        <Badge tone="slate">{flag.status}</Badge>
                      </div>
                      {flag.description ? (
                        <p className="text-sm text-slate-700 leading-snug">{flag.description}</p>
                      ) : (
                        <p className="text-sm text-slate-400 italic">No description</p>
                      )}
                      <p className="text-[11px] text-slate-500 mt-1.5">
                        Raised {relativeTime(flag.raised_at)}
                      </p>
                    </div>
                  </div>
                </Card>
              )
            })}
          </ul>
        )}
      </section>

      {/* Inspection history */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Inspection history</h2>
        <Card>
          <div className="p-5 flex items-start gap-3">
            <div className="p-2 rounded-md bg-slate-100">
              <ClipboardCheck size={16} className="text-slate-700" aria-hidden />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-900">No inspections yet</p>
              <p className="text-sm text-slate-600 mt-0.5">
                The turnover and pre-arrival inspection workflow ships in the next
                feature session. When live, every past inspection will appear here
                with its state, photos, and flags.
              </p>
            </div>
            <Badge tone="sky" className="self-start">Next session</Badge>
          </div>
        </Card>
      </section>

      {/* Roadmap blurb */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Coming for this apartment</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <RoadmapMiniCard
            icon={ClipboardCheck}
            label="Turnover inspection"
            phase="Next session"
          />
          <RoadmapMiniCard
            icon={Camera}
            label="Evidence camera & photos"
            phase="v1.0"
          />
          <RoadmapMiniCard
            icon={ChevronRight}
            label="Flag triage & child actions"
            phase="v1.0"
          />
        </div>
      </section>

      {/* Footer info */}
      <section className="pt-6 border-t border-slate-200">
        <div className="flex items-start gap-3 text-xs text-slate-500">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <p>
            Approval cap, owner link, and template overrides for this apartment
            inherit the company defaults. Per-property overrides become editable when
            the settings page ships in v1.2.
          </p>
        </div>
      </section>
    </AppShell>
  )
}

function RoadmapMiniCard({
  icon: Icon,
  label,
  phase,
}: {
  icon: LucideIcon
  label: string
  phase: string
}) {
  return (
    <Card>
      <div className="p-3 flex items-center gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-md bg-slate-100 flex items-center justify-center">
          <Icon size={14} className="text-slate-600" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-slate-900 truncate">{label}</p>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">{phase}</p>
        </div>
      </div>
    </Card>
  )
}
