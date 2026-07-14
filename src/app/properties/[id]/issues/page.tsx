import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  ChevronRight,
  Flag as FlagIcon,
  Plus,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonClasses } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  FLAG_CATEGORY_GROUPS,
  flagCategoryGroupId,
  getFlagCategoryDisplay,
  severityDisplay,
} from '@/lib/ui/flag-category'
import { flagStatusDisplay } from '@/lib/ui/flag-status'
import { relativeTime } from '@/lib/ui/relative-time'

/**
 * GET /properties/[id]/issues
 *
 * Session 9B — the Apartment Issue Centre / "View all reported issues".
 *
 * The apartment page shows only the latest 1–2 open issues per category
 * so it doesn't become a wall of items; this page is the full list for
 * one apartment, with simple status (Open / All) and category filters.
 *
 * Read-only listing. Each row links to the flag detail page for triage.
 * Language is deliberately "issues" / "reported issues" (not "tickets").
 */

type CategoryRel = { id: string; key: string } | { id: string; key: string }[] | null

type IssueRow = {
  id: string
  status: string
  severity: string
  description: string | null
  issue_title?: string | null
  asana_task_url?: string | null
  raised_at: string
  flag_category: CategoryRel
}

function pickCategory(value: CategoryRel): { id: string; key: string } | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ category?: string; status?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id } = await params
  const { category: categoryFilter, status: statusFilter } = await searchParams
  const showAll = statusFilter === 'all'
  const activeGroupId = categoryFilter ?? null

  const supabase = await createClient()

  const propertyPromise = supabase
    .from('properties')
    .select('id, name')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; name: string }>()

  let issuesQuery = supabase
    .from('flags')
    .select(
      `
      id, status, severity, description, issue_title, asana_task_url, raised_at,
      flag_category:flag_categories ( id, key )
      `,
    )
    .eq('property_id', id)
    .is('deleted_at', null)
  if (!showAll) {
    issuesQuery = issuesQuery.not('status', 'in', '(closed,no_action)')
  }

  const [{ data: property }, { data: issues, error }] = await Promise.all([
    propertyPromise,
    issuesQuery
      .order('raised_at', { ascending: false })
      .limit(200)
      .returns<IssueRow[]>(),
  ])

  if (!property) notFound()

  // Group by display category (same grouping the apartment page uses).
  const byGroup = new Map<string, IssueRow[]>()
  const other: IssueRow[] = []
  for (const f of issues ?? []) {
    const cat = pickCategory(f.flag_category)
    const groupId = cat ? flagCategoryGroupId(cat.key) : null
    if (groupId) {
      const arr = byGroup.get(groupId) ?? []
      arr.push(f)
      byGroup.set(groupId, arr)
    } else {
      other.push(f)
    }
  }

  const presentGroups = FLAG_CATEGORY_GROUPS.filter(
    (g) => (byGroup.get(g.id)?.length ?? 0) > 0,
  )
  const hasOther = other.length > 0

  // Build the href for a filter chip, preserving the other dimension.
  function filterHref(opts: { category?: string | null; status?: string | null }): string {
    const cat = opts.category === undefined ? activeGroupId : opts.category
    const status = opts.status === undefined ? (showAll ? 'all' : null) : opts.status
    const p = new URLSearchParams()
    if (cat) p.set('category', cat)
    if (status) p.set('status', status)
    const qs = p.toString()
    return `/properties/${id}/issues${qs ? `?${qs}` : ''}`
  }

  // Which sections to render given the active category filter.
  let sections: { id: string; label: string; flags: IssueRow[] }[]
  if (activeGroupId === 'other') {
    sections = hasOther ? [{ id: 'other', label: 'Other', flags: other }] : []
  } else if (activeGroupId) {
    const g = FLAG_CATEGORY_GROUPS.find((x) => x.id === activeGroupId)
    const fl = byGroup.get(activeGroupId) ?? []
    sections = g && fl.length > 0 ? [{ id: g.id, label: g.label, flags: fl }] : []
  } else {
    sections = presentGroups.map((g) => ({
      id: g.id,
      label: g.label,
      flags: byGroup.get(g.id) ?? [],
    }))
    if (hasOther) sections.push({ id: 'other', label: 'Other', flags: other })
  }

  const totalShown = sections.reduce((n, s) => n + s.flags.length, 0)

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

      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Reported issues
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Open and historical issues for this apartment.
          </p>
        </div>
        <Link
          href={`/properties/${property.id}/flags/new`}
          className={buttonClasses('primary', 'md', 'shrink-0')}
        >
          <Plus size={16} aria-hidden />
          Report issue
        </Link>
      </div>

      {/* Filters — compact panel (Session 9C.1 polish). Two labelled rows
          (Status, Category) so the controls read as a deliberate panel
          rather than loose chips. */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4 mb-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 w-[68px] shrink-0">
            Status
          </span>
          <FilterChip active={!showAll} href={filterHref({ status: null })}>
            Open
          </FilterChip>
          <FilterChip active={showAll} href={filterHref({ status: 'all' })}>
            All
          </FilterChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 w-[68px] shrink-0">
            Category
          </span>
          <FilterChip active={!activeGroupId} href={filterHref({ category: null })}>
            All
          </FilterChip>
          {presentGroups.map((g) => (
            <FilterChip
              key={g.id}
              active={activeGroupId === g.id}
              href={filterHref({ category: g.id })}
            >
              {g.label} ({byGroup.get(g.id)?.length ?? 0})
            </FilterChip>
          ))}
          {hasOther ? (
            <FilterChip
              active={activeGroupId === 'other'}
              href={filterHref({ category: 'other' })}
            >
              Other ({other.length})
            </FilterChip>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert tone="error">
          <span className="font-medium">Could not load issues.</span> {error.message}
        </Alert>
      ) : totalShown === 0 ? (
        <EmptyState
          icon={FlagIcon}
          title={showAll ? 'No issues found' : 'No open issues'}
          description={
            activeGroupId
              ? 'Nothing matches this filter. Try “All” categories, or include resolved with “All”.'
              : showAll
                ? 'No issues have been reported on this apartment yet.'
                : 'Nothing needs attention right now. Report a new issue when something comes up.'
          }
          action={
            <Link
              href={`/properties/${property.id}/flags/new`}
              className={buttonClasses('primary', 'md')}
            >
              <Plus size={16} aria-hidden />
              Report issue
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          {sections.map((sec) => (
            <div key={sec.id}>
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  {sec.label}
                </h2>
                <span className="text-xs text-slate-500 tabular-nums">
                  ({sec.flags.length})
                </span>
              </div>
              <ul className="space-y-2.5">
                {sec.flags.map((issue) => (
                  <IssueRowCard key={issue.id} issue={issue} propertyId={property.id} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  )
}

function FilterChip({
  active,
  href,
  children,
}: {
  active: boolean
  href: string
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'inline-flex items-center rounded-full bg-slate-900 text-white px-3 py-1.5 text-xs font-medium transition-colors'
          : 'inline-flex items-center rounded-full bg-white border border-slate-300 text-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 transition-colors'
      }
    >
      {children}
    </Link>
  )
}

function IssueRowCard({
  issue,
  propertyId,
}: {
  issue: IssueRow
  propertyId: string
}) {
  const cat = pickCategory(issue.flag_category)
  const display = cat ? getFlagCategoryDisplay(cat.key) : undefined
  const Icon = display?.icon ?? FlagIcon
  const sev = severityDisplay(issue.severity)
  const status = flagStatusDisplay(issue.status)

  return (
    <li>
      <Link
        href={`/properties/${propertyId}/flags/${issue.id}`}
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
              {display?.label ?? 'Issue'}
            </span>
            <Badge tone={sev.tone}>{sev.label}</Badge>
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium">
              <span
                className={`w-1.5 h-1.5 rounded-full ${issue.asana_task_url ? 'bg-emerald-500' : 'bg-amber-400'}`}
                aria-hidden
              />
              <span className={issue.asana_task_url ? 'text-emerald-700' : 'text-amber-700'}>
                {issue.asana_task_url ? 'Asana logged' : 'Asana pending'}
              </span>
            </span>
          </div>
          <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
            {issue.issue_title?.trim() || issue.description?.trim() || 'No description'}
          </p>
          {issue.issue_title?.trim() && issue.description?.trim() ? (
            <p className="text-xs text-slate-500 leading-snug mt-0.5 line-clamp-2">
              {issue.description}
            </p>
          ) : null}
          <p className="text-[11px] text-slate-500 mt-1">
            Raised {relativeTime(issue.raised_at)}
          </p>
        </div>
        <ChevronRight
          size={16}
          className="shrink-0 text-slate-400 self-center"
          aria-hidden
        />
      </Link>
    </li>
  )
}
