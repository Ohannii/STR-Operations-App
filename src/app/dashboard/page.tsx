import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  Building2,
  Calendar,
  ClipboardCheck,
  Flag,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wrench,
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
import { propertyStatusDisplay } from '@/lib/ui/property-status'

/**
 * GET /dashboard
 *
 * The home screen for an authenticated user with a company. Four
 * sections:
 *   1. Welcome + operational snapshot (4 honest count cards;
 *      sections that aren't built yet show greyed-out 0 with a
 *      "coming with X" hint instead of pretending we have data).
 *   2. Properties: real cards driven by the properties table,
 *      with semantic status badges and a clear add-property CTA.
 *      Empty state explains what to do.
 *   3. Coming next: a roadmap card grid that matches the
 *      v1.0–v1.3 plan in PRODUCT_REQUIREMENTS.md. Honest about
 *      what is and isn't shipped.
 *   4. Tiny footer note about the staging environment.
 */
export default async function DashboardPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  // Parallel reads. RLS scopes every query to the user's company,
  // so we don't need an explicit company_id filter — but the
  // counts MUST reflect reality across all the company's
  // apartments, which is exactly what the company-scoped RLS gives
  // us. These are the numbers management trusts, so they're real
  // queries now (the open-flags + open-recovery counts used to be
  // hardcoded 0 placeholders).
  const propertiesPromise = supabase
    .from('properties')
    .select('id, name, address, status, bedrooms, unit_reference')
    .is('deleted_at', null)
    .order('name', { ascending: true })

  // Open flags = anything NOT in a terminal status. Matches the
  // Action Centre's open-flags filter exactly
  // (.not('status', 'in', '(closed,no_action)')) so the company
  // dashboard count and the per-apartment list never disagree.
  // head:true → count only, no rows fetched.
  const openFlagsCountPromise = supabase
    .from('flags')
    .select('id', { count: 'exact', head: true })
    .not('status', 'in', '(closed,no_action)')
    .is('deleted_at', null)

  // Open recovery tasks = non-terminal guest-recovery tasks.
  // Same filter the Action Centre uses for its recovery tile.
  const openRecoveryCountPromise = supabase
    .from('guest_recovery_tasks')
    .select('id', { count: 'exact', head: true })
    .not('status', 'in', '(closed,guest_resolved,ota_resolved)')
    .is('deleted_at', null)

  const [
    { data: properties, error },
    { count: openFlagsCount },
    { count: openRecoveryCount },
  ] = await Promise.all([
    propertiesPromise,
    openFlagsCountPromise,
    openRecoveryCountPromise,
  ])

  const propertyCount = properties?.length ?? 0
  const userDisplayName = ctx.profile?.full_name ?? ctx.user.email ?? 'there'
  const firstName = userDisplayName.split(' ')[0]

  return (
    <AppShell
      companyName={ctx.company.name}
      userName={ctx.profile?.full_name ?? 'Account'}
      userEmail={ctx.user.email ?? ''}
    >
      {/* Welcome + operational snapshot */}
      <section className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-slate-900 tracking-tight">
              Welcome back, {firstName}.
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Operational snapshot for{' '}
              <span className="font-medium text-slate-900">{ctx.company.name}</span>.
            </p>
          </div>
          <span className="text-xs text-slate-500 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Staging environment
          </span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SnapshotCard
            icon={Building2}
            label="Properties"
            value={propertyCount}
            hint={propertyCount === 0 ? 'Add your first to get going.' : 'Managed apartments.'}
          />
          <SnapshotCard
            icon={Flag}
            label="Open flags"
            value={openFlagsCount ?? 0}
            href="/dashboard/flags"
            hint={
              (openFlagsCount ?? 0) === 0
                ? 'Nothing open right now.'
                : 'View all open flags.'
            }
          />
          <SnapshotCard
            icon={ClipboardCheck}
            label="Pending inspections"
            value={0}
            hint="Ships with the turnover workflow."
            muted
          />
          <SnapshotCard
            icon={RotateCcw}
            label="Open recovery tasks"
            value={openRecoveryCount ?? 0}
            hint={
              (openRecoveryCount ?? 0) === 0
                ? 'No guest recovery in flight.'
                : 'Guest damage recovery.'
            }
            muted={(openRecoveryCount ?? 0) === 0}
          />
        </div>
      </section>

      {/* Properties */}
      <section className="mb-12">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Properties</h2>
            <p className="text-sm text-slate-600">
              All apartments managed under this company.
            </p>
          </div>
          <Link href="/properties/new" className={buttonClasses('primary', 'md')}>
            <Plus size={16} aria-hidden />
            Add property
          </Link>
        </div>

        {error ? (
          <Alert tone="error">
            <span className="font-medium">Could not load properties.</span>{' '}
            {error.message}
          </Alert>
        ) : !properties || properties.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No properties yet"
            description={
              <>
                Add your first apartment to begin tracking inspections, flags,
                evidence, and operational status in one place.
              </>
            }
            action={
              <Link href="/properties/new" className={buttonClasses('primary', 'md')}>
                <Plus size={16} aria-hidden />
                Add your first property
              </Link>
            }
          />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {properties.map((p) => {
              const status = propertyStatusDisplay(p.status)
              const sub = [p.unit_reference, p.address].filter(Boolean).join(' · ')
              return (
                <Link
                  key={p.id}
                  href={`/properties/${p.id}`}
                  className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
                  aria-label={`Open ${p.name}`}
                >
                  <Card className="h-full hover:border-slate-300 hover:shadow transition-all">
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">
                            {p.name}
                          </h3>
                          {sub ? (
                            <p className="text-sm text-slate-600 mt-0.5 truncate">{sub}</p>
                          ) : (
                            <p className="text-sm text-slate-400 mt-0.5 italic">
                              No address
                            </p>
                          )}
                        </div>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </div>
                      <dl className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                        <div>
                          <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                            Bedrooms
                          </dt>
                          <dd className="text-sm font-medium text-slate-900 mt-0.5">
                            {p.bedrooms ?? '—'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                            Last inspection
                          </dt>
                          <dd className="text-sm font-medium text-slate-500 mt-0.5">
                            Never
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </Card>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      {/* Roadmap */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-semibold text-slate-900">What ships next</h2>
          <Badge tone="sky">v1.0 build</Badge>
        </div>
        <p className="text-sm text-slate-600 mb-5">
          The inspection foundation is being built in deliberate stages. This is
          what&rsquo;s coming.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <RoadmapCard
            icon={Building2}
            title="Apartment Action Centre"
            description="Per-property dashboard with status, open flags, recent inspections, and quick-add buttons for damage / maintenance / inventory."
            phase="Next session"
            phaseTone="emerald"
          />
          <RoadmapCard
            icon={ClipboardCheck}
            title="Turnover inspection"
            description="Guided post-stay + pre-arrival checklist with photo capture, evidence camera mode, and Mark-All-OK at section level."
            phase="v1.0"
            phaseTone="sky"
          />
          <RoadmapCard
            icon={Flag}
            title="Flag capture & taxonomy"
            description="One parent flag per real-world problem with child actions: cleaning, maintenance, owner approval, guest notification."
            phase="v1.0"
            phaseTone="sky"
          />
          <RoadmapCard
            icon={Wrench}
            title="Maintenance + guest recovery"
            description="Issues, maintenance jobs with before/after photos, and the same-day guest recovery workflow with copy-paste WhatsApp templates."
            phase="v1.1"
            phaseTone="slate"
          />
          <RoadmapCard
            icon={ShieldCheck}
            title="Approval policies enforced"
            description="Per-property monthly/annual caps actively enforced, pending-owner-approval flow, emergency override path for safety/urgent."
            phase="v1.2"
            phaseTone="slate"
          />
          <RoadmapCard
            icon={Calendar}
            title="Owner monthly summary"
            description="Print-quality owner reports, weekly status updates, owner-viewer access, annual audit template."
            phase="v1.3"
            phaseTone="slate"
          />
        </div>
      </section>

      {/* Footer note */}
      <section className="mt-10 pt-6 border-t border-slate-200">
        <div className="flex items-start gap-3 text-xs text-slate-500">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <p>
            This is the v1.0 foundation. AI-assisted features are deferred to v1.5+
            (see <span className="font-mono">docs/AI_FEATURE_ROADMAP.md</span>); the
            v1 product is the operational source of truth those features will sit on.
          </p>
        </div>
      </section>
    </AppShell>
  )
}

function SnapshotCard({
  icon: Icon,
  label,
  value,
  hint,
  muted = false,
  href,
}: {
  icon: LucideIcon
  label: string
  value: number
  hint?: string
  muted?: boolean
  href?: string
}) {
  const inner = (
    <Card className={href ? 'h-full transition hover:border-slate-300 hover:shadow-sm' : undefined}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-slate-600">{label}</span>
          <Icon size={14} className={muted ? 'text-slate-300' : 'text-slate-400'} aria-hidden />
        </div>
        <p
          className={
            muted
              ? 'text-2xl font-semibold text-slate-300 tabular-nums'
              : 'text-2xl font-semibold text-slate-900 tabular-nums'
          }
        >
          {value}
        </p>
        {hint ? <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">{hint}</p> : null}
      </div>
    </Card>
  )

  return href ? (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
    >
      {inner}
    </Link>
  ) : (
    inner
  )
}

function RoadmapCard({
  icon: Icon,
  title,
  description,
  phase,
  phaseTone,
}: {
  icon: LucideIcon
  title: string
  description: string
  phase: string
  phaseTone: 'sky' | 'emerald' | 'slate'
}) {
  return (
    <Card className="flex flex-col">
      <div className="p-5 flex-1">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="p-2 rounded-md bg-slate-100">
            <Icon size={16} className="text-slate-700" aria-hidden />
          </div>
          <Badge tone={phaseTone}>{phase}</Badge>
        </div>
        <h3 className="font-semibold text-slate-900 mb-1">{title}</h3>
        <p className="text-sm text-slate-600 leading-relaxed">{description}</p>
      </div>
    </Card>
  )
}
