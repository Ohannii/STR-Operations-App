import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Flag,
  Hourglass,
  Info,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { StaticChip, ToggleChip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  CHIP_WORKFLOW_GROUPS,
  eligibleChipKinds,
  getChipDisplay,
  type ChipKind,
} from '@/lib/ui/chip-vocabulary'
import {
  FLAG_CATEGORY_GROUPS,
  flagCategoryGroupId,
  getFlagCategoryDisplay,
  QUICK_ADD_KEYS,
  severityDisplay,
} from '@/lib/ui/flag-category'
import { propertyStatusDisplay } from '@/lib/ui/property-status'
import { relativeTime } from '@/lib/ui/relative-time'
import { updateFlagAction } from './flags/[flagId]/actions'
import { toggleFlagMarkAction } from './flags/[flagId]/marks/actions'

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
 *
 * Performance: the property and flags queries run in parallel
 * (independent — both keyed by `id` from params). The flags query
 * embeds flag_categories via PostgREST so we don't need a follow-up
 * `flag_categories.in(ids)` lookup.
 */

// Loose row shape for the embedded flag_categories relation.
type FlagRow = {
  id: string
  status: string
  severity: string
  description: string | null
  raised_at: string
  // Session 7: needed for inline chip eligibility on Action Centre.
  chargeable_party_decision: string | null
  flag_category: { id: string; key: string } | { id: string; key: string }[] | null
}

function pickCategory(value: FlagRow['flag_category']): { id: string; key: string } | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export default async function PropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    raised?: string
    open?: string
    error?: string
  }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id } = await params
  const { raised, open, error } = await searchParams

  // Session 7: which flag cards are expanded inline. URL is the
  // source of truth so chip-toggle + Mark-Resolved actions can
  // round-trip through a server action without losing the visual
  // state. Empty/whitespace tokens get filtered.
  const expandedIds = new Set(
    (open ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

  const supabase = await createClient()

  // Parallel reads. RLS scopes both to the user's company; misses
  // are silent (null + empty array) so we use a simple notFound on
  // the property and an empty-state on flags.
  const propertyPromise = supabase
    .from('properties')
    .select('id, name, address, unit_reference, status, bedrooms, notes, created_at')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  const flagsPromise = supabase
    .from('flags')
    .select(
      `
      id,
      status,
      severity,
      description,
      raised_at,
      chargeable_party_decision,
      flag_category:flag_categories (
        id,
        key
      )
      `,
    )
    .eq('property_id', id)
    .not('status', 'in', '(closed,no_action)')
    .is('deleted_at', null)
    .order('raised_at', { ascending: false })
    .limit(50)
    .returns<FlagRow[]>()

  // Session 7 summary tile: open recovery tasks for this property.
  // Head-only count query — no row data needed.
  const openRecoveryCountPromise = supabase
    .from('guest_recovery_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', id)
    .not('status', 'in', '(closed,guest_resolved,ota_resolved)')
    .is('deleted_at', null)

  const [
    { data: property },
    { data: openFlags, error: flagsError },
    { count: openRecoveryCount },
  ] = await Promise.all([propertyPromise, flagsPromise, openRecoveryCountPromise])

  if (!property) notFound()

  // Operational chip marks for the open-flag cards (Session 6).
  // Two-phase: we need the flag IDs from the first query before we
  // can filter marks. Acceptable extra round-trip; rendering the chip
  // row on each card is worth the visibility win.
  const openFlagIds = (openFlags ?? []).map((f) => f.id)
  let activeMarksByFlagId: Record<string, ChipKind[]> = {}
  if (openFlagIds.length > 0) {
    const { data: marks } = await supabase
      .from('flag_operational_marks')
      .select('flag_id, kind')
      .in('flag_id', openFlagIds)
      .is('cleared_at', null)
      .returns<{ flag_id: string; kind: string }[]>()
    activeMarksByFlagId = (marks ?? []).reduce<Record<string, ChipKind[]>>(
      (acc, m) => {
        if (!acc[m.flag_id]) acc[m.flag_id] = []
        acc[m.flag_id].push(m.kind as ChipKind)
        return acc
      },
      {},
    )
  }

  // ----------------------------------------------------------------
  // Session 7: derive summary tile counts from the data we already
  // have (no extra queries needed for these three; the recovery
  // count came from the parallel head-only query above).
  // ----------------------------------------------------------------
  const nowMs = Date.now()
  const overdueCutoffMs = nowMs - 48 * 60 * 60 * 1000 // 48 hours ago

  let readyForAsanaCount = 0
  let ownerApprovalPendingCount = 0
  let overdueCount = 0
  for (const f of openFlags ?? []) {
    const marks = activeMarksByFlagId[f.id] ?? []
    if (marks.includes('asana_pending')) readyForAsanaCount++
    if (marks.includes('awaiting_owner_approval')) ownerApprovalPendingCount++
    // Overdue: still in early lifecycle states AND raised more than
    // 48h ago. Actioned/closed flags are not "overdue" — they're
    // being handled or resolved.
    if (
      (f.status === 'raised' || f.status === 'classified') &&
      new Date(f.raised_at).getTime() < overdueCutoffMs
    ) {
      overdueCount++
    }
  }

  // ----------------------------------------------------------------
  // Session 7: group open flags by display category. A flag whose
  // category doesn't map to a known group lands in a fallback "Other"
  // bucket so nothing disappears silently.
  // ----------------------------------------------------------------
  const flagsByGroupId = new Map<string, FlagRow[]>()
  const otherFlags: FlagRow[] = []
  for (const f of openFlags ?? []) {
    const cat = pickCategory(f.flag_category)
    const groupId = cat ? flagCategoryGroupId(cat.key) : null
    if (groupId) {
      const arr = flagsByGroupId.get(groupId) ?? []
      arr.push(f)
      flagsByGroupId.set(groupId, arr)
    } else {
      otherFlags.push(f)
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
      {error ? (
        <div className="mb-5">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
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
            const tileTitle = cat.tileLabel ?? cat.label
            const tileSub = cat.tileSubtitle ?? cat.blurb
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
                  {tileTitle}
                </p>
                <p
                  className={
                    isSafety
                      ? 'text-[11px] text-red-700 mt-0.5 leading-snug'
                      : 'text-[11px] text-slate-500 mt-0.5 leading-snug'
                  }
                >
                  {tileSub}
                </p>
              </Link>
            )
          })}
        </div>
      </section>

      {/* Operational snapshot tiles (Session 7).
          Four counts that answer "what should the team do next?" All
          derived from the data we already loaded — no extra queries
          except the open-recovery head-count which ran in parallel
          with the flags query. */}
      <section className="mb-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SnapshotTile
            icon={ClipboardCheck}
            label="Ready for Asana"
            count={readyForAsanaCount}
            tone={readyForAsanaCount > 0 ? 'sky' : 'slate'}
          />
          <SnapshotTile
            icon={Hourglass}
            label="Owner approval pending"
            count={ownerApprovalPendingCount}
            tone={ownerApprovalPendingCount > 0 ? 'amber' : 'slate'}
          />
          <SnapshotTile
            icon={MessageCircle}
            label="Open recovery"
            count={openRecoveryCount ?? 0}
            tone={(openRecoveryCount ?? 0) > 0 ? 'amber' : 'slate'}
          />
          <SnapshotTile
            icon={AlertCircle}
            label="Overdue issues"
            count={overdueCount}
            tone={overdueCount > 0 ? 'red' : 'slate'}
          />
        </div>
      </section>

      {/* Open flags — grouped by category, expand-in-place (Session 7).
          Each card has a collapsed summary + an expanded inline panel
          with workflow-grouped chips + Mark Resolved. Expansion state
          lives in the URL (?open=id1,id2). Chip toggles and Mark
          Resolved round-trip through their server actions but pass a
          return_to so the user lands back here with the same expansion.
       */}
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
          <div className="space-y-6">
            {FLAG_CATEGORY_GROUPS.map((group) => {
              const groupFlags = flagsByGroupId.get(group.id) ?? []
              if (groupFlags.length === 0) return null
              return (
                <CategorySection
                  key={group.id}
                  groupLabel={group.label}
                  flags={groupFlags}
                  propertyId={property.id}
                  expandedIds={expandedIds}
                  activeMarksByFlagId={activeMarksByFlagId}
                />
              )
            })}
            {otherFlags.length > 0 ? (
              <CategorySection
                groupLabel="Other"
                flags={otherFlags}
                propertyId={property.id}
                expandedIds={expandedIds}
                activeMarksByFlagId={activeMarksByFlagId}
              />
            ) : null}
          </div>
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

// ============================================================
// Session 7 — Operational snapshot tile
// ============================================================
// Compact count + label tile with a tone (slate when zero, semantic
// color when there's something to act on). Used as the four cards
// just under the quick-add row.

function SnapshotTile({
  icon: Icon,
  label,
  count,
  tone,
}: {
  icon: LucideIcon
  label: string
  count: number
  tone: 'slate' | 'sky' | 'amber' | 'red'
}) {
  const isActive = count > 0
  const numClass =
    tone === 'slate'
      ? 'text-slate-300'
      : tone === 'sky'
      ? 'text-sky-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : 'text-red-700'
  return (
    <Card>
      <div className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium text-slate-600 uppercase tracking-wide truncate">
            {label}
          </span>
          <Icon
            size={14}
            className={isActive ? 'text-slate-500 shrink-0' : 'text-slate-300 shrink-0'}
            aria-hidden
          />
        </div>
        <p
          className={`text-2xl font-semibold tabular-nums ${
            isActive ? numClass : 'text-slate-300'
          }`}
        >
          {count}
        </p>
      </div>
    </Card>
  )
}

// ============================================================
// Session 7 — Category section + inline-expand flag card
// ============================================================
// CategorySection renders one category group as a heading + the
// inline flag cards inside it. FlagCardInline handles both the
// collapsed summary and the expanded operational panel (workflow
// chip groups + Mark Resolved + View details link).
//
// State preservation: the URL's `?open=` carries the set of
// expanded flag IDs. The summary header is a <Link> that navigates
// to the new ?open state. Chip toggles and Mark Resolved pass a
// `return_to` so their server actions land back here without losing
// the expansion. For Mark Resolved we remove the flag from `?open`
// because it's about to leave the open list anyway.

function CategorySection({
  groupLabel,
  flags,
  propertyId,
  expandedIds,
  activeMarksByFlagId,
}: {
  groupLabel: string
  flags: FlagRow[]
  propertyId: string
  expandedIds: Set<string>
  activeMarksByFlagId: Record<string, ChipKind[]>
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
          {groupLabel}
        </h3>
        <span className="text-xs text-slate-500 tabular-nums">({flags.length})</span>
      </div>
      <ul className="space-y-2.5">
        {flags.map((flag) => (
          <FlagCardInline
            key={flag.id}
            flag={flag}
            propertyId={propertyId}
            expandedIds={expandedIds}
            activeChipKinds={activeMarksByFlagId[flag.id] ?? []}
          />
        ))}
      </ul>
    </div>
  )
}

function buildOpenQuery(ids: string[]): string {
  return ids.length > 0 ? `?open=${ids.join(',')}` : ''
}

function FlagCardInline({
  flag,
  propertyId,
  expandedIds,
  activeChipKinds,
}: {
  flag: FlagRow
  propertyId: string
  expandedIds: Set<string>
  activeChipKinds: ChipKind[]
}) {
  const categoryRow = pickCategory(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
  const Icon = cat?.icon ?? Flag
  const sev = severityDisplay(flag.severity)
  const isExpanded = expandedIds.has(flag.id)

  // The summary <Link> toggles this flag in/out of ?open=. Stable
  // order preserved across re-renders by sorting the resulting set.
  const expandedArr = Array.from(expandedIds)
  const nextOpenIds = isExpanded
    ? expandedArr.filter((idValue) => idValue !== flag.id).sort()
    : [...expandedArr, flag.id].sort()
  const toggleHref = `/properties/${propertyId}${buildOpenQuery(nextOpenIds)}#flag-${flag.id}`

  // return_to URLs:
  //   - chip toggles preserve the current expansion (so the flag
  //     stays expanded after a chip toggle)
  //   - Mark Resolved removes the flag from `?open=` because it's
  //     leaving the open list when closed
  const currentOpenQuery = buildOpenQuery(expandedArr.sort())
  const chipReturnTo = `/properties/${propertyId}${currentOpenQuery}#flag-${flag.id}`
  const resolvedReturnTo = `/properties/${propertyId}${buildOpenQuery(
    expandedArr.filter((idValue) => idValue !== flag.id).sort(),
  )}`

  const activeChipSet = new Set(activeChipKinds)
  const eligibleKinds = isExpanded
    ? eligibleChipKinds({
        chargeable_party_decision: flag.chargeable_party_decision,
        category_key: categoryRow?.key ?? null,
      })
    : []

  return (
    <li id={`flag-${flag.id}`}>
      <Card className="overflow-hidden">
        {/* Collapsed summary header (also the expand/collapse control) */}
        <Link
          href={toggleHref}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} flag: ${cat?.label ?? 'Flag'}`}
          className="block p-4 hover:bg-slate-50/60 focus-visible:outline-none focus-visible:bg-slate-50 transition-colors"
        >
          <div className="flex items-start gap-3">
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
              {activeChipKinds.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {activeChipKinds.map((kind) => {
                    const chip = getChipDisplay(kind)
                    if (!chip) return null
                    return (
                      <StaticChip
                        key={kind}
                        label={chip.label}
                        tone={chip.tone}
                        icon={chip.icon}
                      />
                    )
                  })}
                </div>
              ) : null}
              <p className="text-[11px] text-slate-500 mt-1.5">
                Raised {relativeTime(flag.raised_at)}
              </p>
            </div>
            <ChevronDown
              size={18}
              className={`shrink-0 text-slate-400 transition-transform ${
                isExpanded ? 'rotate-180' : ''
              }`}
              aria-hidden
            />
          </div>
        </Link>

        {/* Expanded panel — workflow chip groups + Mark Resolved */}
        {isExpanded ? (
          <div className="border-t border-slate-100 p-4 space-y-4 bg-slate-50/40">
            {CHIP_WORKFLOW_GROUPS.map((group) => {
              const visibleKinds = group.kinds.filter((k) => eligibleKinds.includes(k))
              if (visibleKinds.length === 0) return null
              return (
                <div key={group.id}>
                  <h4 className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">
                    {group.label}
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {visibleKinds.map((kind) => {
                      const chip = getChipDisplay(kind)
                      if (!chip) return null
                      const isActive = activeChipSet.has(kind)
                      return (
                        <form
                          key={kind}
                          action={toggleFlagMarkAction}
                          className="contents"
                        >
                          <input type="hidden" name="property_id" value={propertyId} />
                          <input type="hidden" name="flag_id" value={flag.id} />
                          <input type="hidden" name="kind" value={kind} />
                          <input type="hidden" name="return_to" value={chipReturnTo} />
                          <ToggleChip
                            active={isActive}
                            label={chip.label}
                            tone={chip.tone}
                            icon={chip.icon}
                          />
                        </form>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {/* Footer actions — View details + Mark resolved */}
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-100">
              <Link
                href={`/properties/${propertyId}/flags/${flag.id}`}
                className="text-xs text-slate-600 hover:text-slate-900 hover:underline inline-flex items-center gap-1"
              >
                View details <ChevronRight size={12} aria-hidden />
              </Link>
              <form action={updateFlagAction}>
                <input type="hidden" name="property_id" value={propertyId} />
                <input type="hidden" name="flag_id" value={flag.id} />
                <input type="hidden" name="status" value="closed" />
                <input type="hidden" name="severity" value={flag.severity} />
                <input
                  type="hidden"
                  name="chargeable_party_decision"
                  value={flag.chargeable_party_decision ?? 'pending_decision'}
                />
                <input type="hidden" name="no_action_reason" value="" />
                <input type="hidden" name="return_to" value={resolvedReturnTo} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 h-9 px-4 text-sm font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 border border-emerald-600 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                  <Check size={14} aria-hidden />
                  Mark resolved
                </button>
              </form>
            </div>
          </div>
        ) : null}
      </Card>
    </li>
  )
}
