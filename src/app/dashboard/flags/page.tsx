import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ChevronRight, Flag as FlagIcon } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Badge } from '@/components/ui/badge'
import { getUserContext } from '@/lib/auth/get-user-context'
import { startPerf } from '@/lib/perf'
import { createClient } from '@/lib/supabase/server'
import { getFlagCategoryDisplay, severityDisplay } from '@/lib/ui/flag-category'
import { flagStatusDisplay } from '@/lib/ui/flag-status'
import { relativeTime } from '@/lib/ui/relative-time'

/**
 * GET /dashboard/flags — company-wide open flags (Slice 11a).
 *
 * Every open flag across all of the company's apartments, newest first.
 * Read-only; each row links to the flag detail page. RLS scopes flags to
 * the caller's company; we also filter on company_id explicitly.
 */

export const dynamic = 'force-dynamic'

type Rel =
  | { id?: string; key?: string; name?: string }
  | { id?: string; key?: string; name?: string }[]
  | null

type OpenFlagRow = {
  id: string
  status: string
  severity: string
  description: string | null
  issue_title: string | null
  asana_task_url: string | null
  raised_at: string
  property_id: string
  property: Rel
  flag_category: Rel
}

function pick(value: Rel): { id?: string; key?: string; name?: string } | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export default async function DashboardFlagsPage() {
  const perf = startPerf('/dashboard/flags')
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  perf.mark('context')

  const supabase = await createClient()
  const { data: flags, error } = await supabase
    .from('flags')
    .select(
      `
      id, status, severity, description, issue_title, asana_task_url, raised_at, property_id,
      property:properties ( id, name ),
      flag_category:flag_categories ( id, key )
      `,
    )
    .eq('company_id', ctx.company.id)
    .not('status', 'in', '(closed,no_action)')
    .is('deleted_at', null)
    .order('raised_at', { ascending: false })
    .limit(200)
    .returns<OpenFlagRow[]>()
  perf.mark('queries')
  perf.done()

  const rows = flags ?? []

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
        Back to dashboard
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Open flags</h1>
        <p className="text-sm text-slate-600 mt-1">
          {rows.length === 0
            ? 'Nothing open across your apartments right now.'
            : `${rows.length} open ${rows.length === 1 ? 'flag' : 'flags'} across all apartments.`}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-red-600">Could not load open flags: {error.message}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-500">No open flags. New issues will appear here.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((flag) => (
            <CompanyFlagRow key={flag.id} flag={flag} />
          ))}
        </ul>
      )}
    </AppShell>
  )
}

function CompanyFlagRow({ flag }: { flag: OpenFlagRow }) {
  const cat = pick(flag.flag_category)
  const property = pick(flag.property)
  const display = cat?.key ? getFlagCategoryDisplay(cat.key) : undefined
  const Icon = display?.icon ?? FlagIcon
  const sev = severityDisplay(flag.severity)
  const status = flagStatusDisplay(flag.status)

  return (
    <li>
      <Link
        href={`/properties/${flag.property_id}/flags/${flag.id}`}
        className="flex items-start gap-3 min-w-0 max-w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 hover:bg-slate-50 active:bg-slate-100 transition"
      >
        <div
          className={
            display?.tone === 'red'
              ? 'shrink-0 w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center'
              : 'shrink-0 w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center'
          }
        >
          <Icon size={16} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {property?.name ?? 'Apartment'} · {display?.label ?? 'Issue'}
            </span>
            <Badge tone={sev.tone}>{sev.label}</Badge>
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium">
              <span
                className={`w-1.5 h-1.5 rounded-full ${flag.asana_task_url ? 'bg-emerald-500' : 'bg-amber-400'}`}
                aria-hidden
              />
              <span className={flag.asana_task_url ? 'text-emerald-700' : 'text-amber-700'}>
                {flag.asana_task_url ? 'Asana logged' : 'Asana pending'}
              </span>
            </span>
          </div>
          <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
            {flag.issue_title?.trim() || flag.description?.trim() || 'No description'}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Raised {relativeTime(flag.raised_at)}</p>
        </div>
        <ChevronRight size={16} className="shrink-0 text-slate-400 self-center" aria-hidden />
      </Link>
    </li>
  )
}
