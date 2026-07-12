import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  Camera,
  Check,
  ExternalLink,
  FileText,
  Flag as FlagIcon,
  ListChecks,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { EvidenceCapture } from '@/components/photos/evidence-capture'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonClasses } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { RadioChip, ToggleChip } from '@/components/ui/chip'
import { Field } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import {
  THUMB_TTL_SECONDS,
  signEvidencePaths,
} from '@/lib/photos/signed-urls'
import { createClient } from '@/lib/supabase/server'
import {
  CHIP_WORKFLOW_GROUPS,
  eligibleChipKinds,
  getChipDisplay,
} from '@/lib/ui/chip-vocabulary'
import { formatDateTimeSAST } from '@/lib/ui/datetime'
import {
  getFlagCategoryDisplay,
  severityDisplay,
} from '@/lib/ui/flag-category'
import {
  CHARGEABLE_PARTIES,
  chargeablePartyDisplay,
  normaliseAccountability,
  FLAG_STATUSES,
  flagStatusDisplay,
  isTerminalStatus,
} from '@/lib/ui/flag-status'
import { issueGuidance } from '@/lib/ui/issue-guidance'
import {
  outcomeDisplay,
  recoveryStatusDisplay,
} from '@/lib/ui/recovery-status'
import { relativeTime, relativeTimeUntil } from '@/lib/ui/relative-time'
import { buildRecoveryMessage, buildWhatsAppUrl, formatZAR } from '@/lib/whatsapp-template'
import {
  addFlagNoteAction,
  reopenFlagAction,
  updateFlagAction,
} from './actions'
import { toggleFlagMarkAction } from './marks/actions'
import {
  closeRecoveryTaskAction,
  markGuestNotifiedAction,
  markGuestPaidAction,
  markGuestRefusedAction,
} from './recovery/[taskId]/actions'
import {
  softDeleteEvidencePhoto,
  updatePhotoNote,
} from '../../photos/actions'

/**
 * GET /properties/[id]/flags/[flagId]
 *
 * Flag detail + triage view. Sections (in order):
 *   1. Header card  — category, status, severity, responsibility,
 *      description, close reason.
 *   2. Triage form  — status / severity / responsibility chips +
 *      close-reason textarea.
 *   3. Guest recovery — only shown when eligible (responsibility =
 *      Guest, OR category = guest_damage, OR a recovery task already
 *      exists). Inline card with guest contact, amounts, deadline,
 *      WhatsApp + transition actions, and a mini activity log.
 *   4. Reopen affordance — only for closed / no_action flags.
 *   5. Activity timeline — flag-level history.
 *   6. Add-note form.
 *
 * Data loaded in parallel: property, flag, audit_events, recovery
 * task (with embedded stay + attempts).
 */

type FlagCategoryRel = { id: string; key: string } | { id: string; key: string }[] | null

type FlagDetail = {
  id: string
  status: string
  severity: string
  description: string | null
  issue_title: string | null
  chargeable_party_decision: string | null
  no_action_reason: string | null
  raised_at: string
  raised_by: string
  classified_at: string | null
  classified_by: string | null
  actioned_at: string | null
  closed_at: string | null
  asana_task_url: string | null
  flag_category: FlagCategoryRel
}

type AuditEventRow = {
  id: string
  event_kind: string
  actor_id: string | null
  before: unknown
  after: unknown
  metadata: unknown
  created_at: string
}

type EvidencePhotoRow = {
  id: string
  storage_path: string
  thumbnail_path: string | null
  notes: string | null
  captured_at: string | null
  uploaded_at: string
  uploaded_by: string
  width: number | null
  height: number | null
  size_bytes: number | null
}

type StayEmbed = {
  id: string
  guest_first_name: string | null
  guest_phone: string | null
  guest_email: string | null
}

type RecoveryAttempt = {
  id: string
  attempt_type: string
  attempt_method: string | null
  message_sent_at: string | null
  outcome: string | null
  amount_recovered: number | string | null
  notes: string | null
  recorded_at: string
  recorded_by: string | null
}

type RecoveryTask = {
  id: string
  status: string
  description: string | null
  estimated_amount: number | string | null
  actual_amount: number | string | null
  deadline_at: string
  closed_at: string | null
  final_chargeable_party: string | null
  created_at: string
  created_by: string
  stay: StayEmbed | StayEmbed[] | null
  recovery_attempts: RecoveryAttempt[] | null
}

function pickEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/** Coerce PostgREST decimal-as-string to a number where present. */
function asNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export default async function FlagDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; flagId: string }>
  searchParams: Promise<{
    updated?: string
    note_added?: string
    reopened?: string
    recovery_created?: string
    notified?: string
    paid?: string
    refused?: string
    closed?: string
    mark_toggled?: string
    photo_updated?: string
    photo_deleted?: string
    error?: string
  }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId, flagId } = await params
  const {
    updated,
    note_added,
    reopened,
    recovery_created,
    notified,
    paid,
    refused,
    closed,
    mark_toggled,
    photo_updated,
    photo_deleted,
    error,
  } = await searchParams

  const supabase = await createClient()

  // Parallel reads. RLS keeps each within the user's company.
  const propertyPromise = supabase
    .from('properties')
    .select('id, name')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; name: string }>()

  const flagPromise = supabase
    .from('flags')
    .select(
      `
      id,
      status,
      severity,
      description,
      issue_title,
      chargeable_party_decision,
      no_action_reason,
      raised_at,
      raised_by,
      classified_at,
      classified_by,
      actioned_at,
      closed_at,
      asana_task_url,
      flag_category:flag_categories (id, key)
      `,
    )
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<FlagDetail>()

  const auditPromise = supabase
    .from('audit_events')
    .select('id, event_kind, actor_id, before, after, metadata, created_at')
    .eq('entity_type', 'flag')
    .eq('entity_id', flagId)
    .order('created_at', { ascending: true })
    .returns<AuditEventRow[]>()

  const recoveryPromise = supabase
    .from('guest_recovery_tasks')
    .select(
      `
      id, status, description, estimated_amount, actual_amount,
      deadline_at, closed_at, final_chargeable_party,
      created_at, created_by,
      stay:stays (id, guest_first_name, guest_phone, guest_email),
      recovery_attempts (
        id, attempt_type, attempt_method, message_sent_at,
        outcome, amount_recovered, notes, recorded_at, recorded_by
      )
      `,
    )
    .eq('parent_flag_id', flagId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .returns<RecoveryTask[]>()

  // Operational marks (chips). Only the currently-active ones; the
  // partial unique index guarantees at most one active row per
  // (flag_id, kind).
  const marksPromise = supabase
    .from('flag_operational_marks')
    .select('id, kind, marked_at, marked_by')
    .eq('flag_id', flagId)
    .is('cleared_at', null)
    .returns<{ id: string; kind: string; marked_at: string; marked_by: string }[]>()

  // Session 8: evidence photos attached to this flag. Ordered by
  // captured_at descending (falls back to uploaded_at via coalesce
  // in app code) so newest evidence renders first.
  const photosPromise = supabase
    .from('photos')
    .select(
      `id, storage_path, thumbnail_path, notes, captured_at,
       uploaded_at, uploaded_by, width, height, size_bytes`,
    )
    .eq('flag_id', flagId)
    .is('deleted_at', null)
    .order('captured_at', { ascending: false, nullsFirst: false })
    .order('uploaded_at', { ascending: false })
    .returns<EvidencePhotoRow[]>()

  const [
    { data: property },
    { data: flag },
    { data: auditEvents },
    { data: recoveryRows },
    { data: activeMarks },
    { data: evidencePhotos },
  ] = await Promise.all([
    propertyPromise,
    flagPromise,
    auditPromise,
    recoveryPromise,
    marksPromise,
    photosPromise,
  ])

  if (!property || !flag) notFound()

  // Session 8: sign thumbnail URLs in bulk (one round trip).
  // Master URLs are NOT pre-signed at render — clicking a tile
  // navigates to /properties/[id]/photos/[photoId]/view which
  // signs the master on demand and 302-redirects to storage. This
  // keeps the cost-per-render bounded regardless of how many photos
  // are attached, and avoids master URLs expiring before the user
  // clicks them.
  const photoRows = evidencePhotos ?? []
  const thumbPaths = photoRows
    .map((p) => p.thumbnail_path)
    .filter((p): p is string => Boolean(p))
  const thumbUrlMap =
    thumbPaths.length > 0
      ? await signEvidencePaths(thumbPaths, THUMB_TTL_SECONDS)
      : {}

  const categoryRow = pickEmbedded(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
  const status = flagStatusDisplay(flag.status)
  const sev = severityDisplay(flag.severity)
  const charge = chargeablePartyDisplay(flag.chargeable_party_decision)
  const isClosed = isTerminalStatus(flag.status)
  const currentUserId = ctx.user.id
  const CatIcon: LucideIcon = cat?.icon ?? FlagIcon

  // Session 9C: category-aware "what needs to happen next" guidance.
  const guidance = issueGuidance({
    categoryKey: categoryRow?.key ?? null,
    status: flag.status,
  })
  const guidanceCardTone =
    guidance.tone === 'urgent'
      ? 'border-amber-300 bg-amber-50'
      : guidance.tone === 'resolved'
        ? 'border-emerald-200 bg-emerald-50/60'
        : 'border-slate-200 bg-slate-50/70'
  const guidanceIconTone =
    guidance.tone === 'urgent'
      ? 'bg-amber-500 text-white'
      : guidance.tone === 'resolved'
        ? 'bg-emerald-600 text-white'
        : 'bg-slate-900 text-white'

  // Active operational chips for this flag. Set of kinds for fast
  // O(1) lookup when rendering the toggle row.
  const activeChipKinds = new Set<string>((activeMarks ?? []).map((m) => m.kind))

  // Eligible chip kinds for this flag's category + responsibility.
  // Stable order; some chips only show in context (e.g., `replaced`
  // only on inventory flags; `needs_reclean` only on cleaning flags).
  const chipKindsForFlag = eligibleChipKinds({
    chargeable_party_decision: flag.chargeable_party_decision,
    category_key: categoryRow?.key ?? null,
  })

  // Recovery eligibility:
  //   - Existing task always shows.
  //   - No task, but responsibility is Guest OR category is guest_damage
  //     → show the create-task CTA.
  // Per user spec: don't gate by category alone — a Maintenance flag
  // whose responsibility was set to Guest in triage is eligible.
  const recoveryTask = recoveryRows?.[0] ?? null
  const stayEmbed = recoveryTask ? pickEmbedded(recoveryTask.stay) : null
  const recoveryAttempts = recoveryTask?.recovery_attempts ?? []
  const isCategoryGuestDamage = categoryRow?.key === 'guest_damage'
  const isResponsibilityGuest = flag.chargeable_party_decision === 'guest'
  const showRecoverySection =
    Boolean(recoveryTask) || isCategoryGuestDamage || isResponsibilityGuest

  // Build the flag-level activity timeline.
  type Item =
    | { kind: 'raised'; at: Date; actorId: string | null; description: string | null }
    | { kind: 'update'; at: Date; actorId: string | null; before: Record<string, unknown>; after: Record<string, unknown> }
    | { kind: 'note'; at: Date; actorId: string | null; note: string }
    | { kind: 'reopen'; at: Date; actorId: string | null }

  const items: Item[] = []
  items.push({
    kind: 'raised',
    at: new Date(flag.raised_at),
    actorId: flag.raised_by,
    description: flag.description,
  })

  for (const e of auditEvents ?? []) {
    const at = new Date(e.created_at)
    if (e.event_kind === 'flag_note') {
      const meta = (e.metadata ?? {}) as { note?: unknown }
      const note = typeof meta.note === 'string' ? meta.note : ''
      items.push({ kind: 'note', at, actorId: e.actor_id, note })
    } else if (e.event_kind === 'flag_reopen') {
      items.push({ kind: 'reopen', at, actorId: e.actor_id })
    } else if (e.event_kind === 'flag_update') {
      items.push({
        kind: 'update',
        at,
        actorId: e.actor_id,
        before: (e.before ?? {}) as Record<string, unknown>,
        after: (e.after ?? {}) as Record<string, unknown>,
      })
    }
  }

  items.sort((a, b) => a.at.getTime() - b.at.getTime())

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

      {/* Flash messages */}
      {updated ? (
        <div className="mb-5">
          <Alert tone="success">Flag updated. Activity timeline below.</Alert>
        </div>
      ) : null}
      {note_added ? (
        <div className="mb-5">
          <Alert tone="success">Note added.</Alert>
        </div>
      ) : null}
      {reopened ? (
        <div className="mb-5">
          <Alert tone="success">Flag reopened. Status is back to &lsquo;raised&rsquo;.</Alert>
        </div>
      ) : null}
      {recovery_created ? (
        <div className="mb-5">
          <Alert tone="success">Recovery task created. Send the WhatsApp message below to notify the guest.</Alert>
        </div>
      ) : null}
      {notified ? (
        <div className="mb-5">
          <Alert tone="success">Marked guest notified. Now waiting for their response.</Alert>
        </div>
      ) : null}
      {paid ? (
        <div className="mb-5">
          <Alert tone="success">Marked as paid. Recovery resolved.</Alert>
        </div>
      ) : null}
      {refused ? (
        <div className="mb-5">
          <Alert tone="success">Marked as refused. Recovery moved to fallback decision.</Alert>
        </div>
      ) : null}
      {closed ? (
        <div className="mb-5">
          <Alert tone="success">Recovery task closed.</Alert>
        </div>
      ) : null}
      {mark_toggled ? (
        <div className="mb-5">
          <Alert tone="success">Operational chip updated.</Alert>
        </div>
      ) : null}
      {photo_updated ? (
        <div className="mb-5">
          <Alert tone="success">Photo caption saved.</Alert>
        </div>
      ) : null}
      {photo_deleted ? (
        <div className="mb-5">
          <Alert tone="success">Photo removed from this flag.</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mb-5">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
        </div>
      ) : null}

      {/* Header card */}
      <Card className="mb-6">
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3.5">
            <div
              className={
                cat?.tone === 'red'
                  ? 'shrink-0 w-11 h-11 rounded-lg bg-red-100 text-red-700 flex items-center justify-center'
                  : 'shrink-0 w-11 h-11 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center'
              }
            >
              <CatIcon size={20} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
                {flag.issue_title ? (cat?.label ?? 'Issue') : 'Issue'}
              </p>
              {/* When the inspector gave a short title, show it as the heading
                  with the category demoted to the eyebrow above. break-normal
                  stops the inherited overflow-wrap:anywhere breaking a single
                  word like "Maintenance" mid-character. */}
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight break-normal">
                {flag.issue_title ?? cat?.label ?? 'Issue'}
              </h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Badge tone={status.tone}>{status.label}</Badge>
                <Badge tone={sev.tone}>{sev.label}</Badge>
                <Badge tone={charge.tone}>Responsibility: {charge.label}</Badge>
              </div>
              {/* Secondary actions below the title so they don't squeeze the
                  heading on mobile. Both open in a new tab. */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link
                  href={`/properties/${property.id}/flags/${flag.id}/report`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition"
                >
                  <FileText size={14} aria-hidden />
                  Open report
                  <ExternalLink size={12} className="opacity-60" aria-hidden />
                </Link>
                {flag.asana_task_url ? (
                  <a
                    href={flag.asana_task_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition"
                  >
                    <ExternalLink size={14} aria-hidden />
                    Open Asana task
                  </a>
                ) : null}
              </div>
            </div>
          </div>

          {flag.description ? (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Description
              </p>
              <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                {flag.description}
              </p>
            </div>
          ) : null}

          {flag.no_action_reason ? (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                Close reason
              </p>
              <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                {flag.no_action_reason}
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      {/* Session 9C: category-aware next-steps guidance — tells the user
          what THIS kind of issue typically needs, so an "item missing" or
          "guest damage" issue doesn't read like a generic repair. */}
      <div className={`mb-6 rounded-xl border shadow-sm ${guidanceCardTone}`}>
        <div className="p-5 flex items-start gap-3">
          <div
            className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${guidanceIconTone}`}
          >
            <ListChecks size={18} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
              What needs to happen next
            </p>
            <p className="text-sm font-semibold text-slate-900">{guidance.headline}</p>
            {guidance.steps.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {guidance.steps.map((step, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-slate-700"
                  >
                    <span
                      className="shrink-0 mt-[7px] w-1.5 h-1.5 rounded-full bg-slate-400"
                      aria-hidden
                    />
                    <span className="min-w-0">{step}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>

      {/* Triage form */}
      <Card className="mb-8">
        <div className="p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-slate-900">Triage</h2>
            <p className="text-sm text-slate-600">
              Update lifecycle state, severity, and who&rsquo;s on the hook.
            </p>
          </div>

          <form action={updateFlagAction} className="space-y-5">
            <input type="hidden" name="property_id" value={property.id} />
            <input type="hidden" name="flag_id" value={flag.id} />

            <Field label="Status" required>
              <div className="flex gap-2 flex-wrap">
                {FLAG_STATUSES.map((s) => (
                  <RadioChip
                    key={s}
                    name="status"
                    value={s}
                    label={flagStatusDisplay(s).label}
                    defaultChecked={s === flag.status}
                    tone="slate"
                  />
                ))}
              </div>
            </Field>

            <Field label="Severity" required>
              <div className="flex gap-2">
                <RadioChip
                  name="severity"
                  value="low"
                  label="Low"
                  defaultChecked={flag.severity === 'low'}
                  tone="slate"
                />
                <RadioChip
                  name="severity"
                  value="med"
                  label="Medium"
                  defaultChecked={flag.severity === 'med'}
                  tone="amber"
                />
                <RadioChip
                  name="severity"
                  value="high"
                  label="High"
                  defaultChecked={flag.severity === 'high'}
                  tone="red"
                />
              </div>
            </Field>

            <Field
              label="Responsibility"
              required
              hint="Who pays / is on the hook for this. Drives the cost recovery cascade later."
            >
              <div className="flex gap-2 flex-wrap">
                {CHARGEABLE_PARTIES.map((p) => {
                  // Map legacy/null stored values to the current vocabulary so
                  // exactly one chip is pre-selected for existing flags too.
                  const checked = normaliseAccountability(flag.chargeable_party_decision) === p
                  return (
                    <RadioChip
                      key={p}
                      name="chargeable_party_decision"
                      value={p}
                      label={chargeablePartyDisplay(p).label}
                      defaultChecked={checked}
                      tone="slate"
                    />
                  )
                })}
              </div>
            </Field>

            <Field
              label="Close reason"
              htmlFor="no_action_reason"
              hint='Required only when status is "No action". Free text; will appear on the activity log.'
            >
              <textarea
                id="no_action_reason"
                name="no_action_reason"
                rows={3}
                maxLength={1000}
                defaultValue={flag.no_action_reason ?? ''}
                placeholder='e.g. "Inspected. No damage found. Closing as no action."'
                className="block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 resize-y min-h-[5rem]"
              />
            </Field>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
              <Button type="submit">Save changes</Button>
            </div>
          </form>
        </div>
      </Card>

      {/* Operational status (chips) — the daily-driver UI surface for
          "where is this issue now?" Each chip is a toggle: click to set,
          click again to clear. Predecessor chips auto-clear when a
          successor is set (e.g., setting Maintenance done clears
          Maintenance pending + Maintenance assigned).

          Workflow grouping (Asana / Guest notification / Owner notification
          / Maintenance / Replacement / Owner approval / Cleaning) gives the
          eye anchor points so the chip set scans fast on mobile. Groups
          with no eligible chips for this flag are hidden entirely.

          The "Mark resolved" button at the bottom is a one-tap shortcut
          that submits to updateFlagAction with status=closed — same path
          as the Triage form's status radio, but without the multi-step
          form interaction. Only shown when the flag isn't already terminal.

          See docs/CHIP_VOCABULARY.md for the vocabulary. */}
      <section id="operational" className="mb-8 scroll-mt-20">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-slate-900">Operational status</h2>
          <p className="text-sm text-slate-600">
            Mark progress on this flag. Each chip is independent; tap to set,
            tap again to clear. Predecessors auto-clear when you advance the workflow.
          </p>
        </div>
        <Card>
          <div className="p-5 space-y-5">
            {CHIP_WORKFLOW_GROUPS.map((group) => {
              // Only render chips eligible for this flag's context.
              const visibleKinds = group.kinds.filter((k) =>
                chipKindsForFlag.includes(k),
              )
              if (visibleKinds.length === 0) return null
              return (
                <div key={group.id}>
                  <h3 className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider mb-2">
                    {group.label}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {visibleKinds.map((kind) => {
                      const chip = getChipDisplay(kind)
                      if (!chip) return null
                      const isActive = activeChipKinds.has(kind)
                      return (
                        <form
                          key={kind}
                          action={toggleFlagMarkAction}
                          className="contents"
                        >
                          <input type="hidden" name="property_id" value={property.id} />
                          <input type="hidden" name="flag_id" value={flag.id} />
                          <input type="hidden" name="kind" value={kind} />
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

            {/* Mark resolved — one-tap closeout. Only when flag isn't
                already terminal. Submits via the existing updateFlagAction
                (preserves severity + responsibility, sets status=closed).
                If the user needs the "No action" pathway with a reason,
                the Triage form's status radio handles that. */}
            {!isClosed ? (
              <div className="pt-4 border-t border-slate-100">
                <form action={updateFlagAction} className="flex">
                  <input type="hidden" name="property_id" value={property.id} />
                  <input type="hidden" name="flag_id" value={flag.id} />
                  <input type="hidden" name="status" value="closed" />
                  <input type="hidden" name="severity" value={flag.severity} />
                  <input
                    type="hidden"
                    name="chargeable_party_decision"
                    value={flag.chargeable_party_decision ?? 'pending_decision'}
                  />
                  <input type="hidden" name="no_action_reason" value="" />
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-2 w-full h-11 px-5 text-sm font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 border border-emerald-600 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                  >
                    <Check size={16} aria-hidden />
                    Mark resolved
                  </button>
                </form>
                <p className="mt-2 text-[11px] text-slate-500 text-center">
                  Closes the flag with the current responsibility and severity.
                  Use the Triage form above for &ldquo;No action&rdquo; with a reason.
                </p>
              </div>
            ) : null}
          </div>
        </Card>
      </section>

      {/* Active recovery task -- full section only when a task already exists.
          When a task is in flight it deserves the visible surface and the
          status-dependent action buttons inside RecoveryTaskCard. */}
      {showRecoverySection && recoveryTask ? (
        <section id="recovery" className="mb-8 scroll-mt-20">
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-slate-900">Guest recovery</h2>
            <p className="text-sm text-slate-600">
              Track notification, payment, or refusal. Each step is logged.
            </p>
          </div>
          <RecoveryTaskCard
            task={recoveryTask}
            stay={stayEmbed}
            attempts={recoveryAttempts}
            propertyId={property.id}
            flagId={flag.id}
            propertyName={property.name}
            companyName={ctx.company.name}
            flagDescription={flag.description}
            currentUserId={currentUserId}
          />
        </section>
      ) : null}

      {/* Demoted inline CTA for the rare formal-escalation case --
          only when eligible AND no task exists. Day-to-day operational
          progress (Guest Notified, Asana Logged, Maintenance Assigned,
          etc.) lands on lightweight flag-level chips in Session 6. The
          recovery task workflow is reserved for cases that genuinely
          need a WhatsApp + paid/refused audit trail. */}
      {showRecoverySection && !recoveryTask ? (
        <div className="mb-8">
          <Link
            href={`/properties/${property.id}/flags/${flag.id}/recovery/new`}
            className="text-xs text-slate-500 hover:text-slate-700 hover:underline inline-flex items-center gap-1"
          >
            Need formal guest recovery tracking? Start tracking →
          </Link>
        </div>
      ) : null}

      {/* Reopen affordance */}
      {isClosed ? (
        <Card className="mb-8 border-amber-200 bg-amber-50/40">
          <div className="p-5 flex items-start gap-3">
            <div className="p-2 rounded-md bg-amber-100">
              <RotateCcw size={16} className="text-amber-700" aria-hidden />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-900">
                This issue is {status.label.toLowerCase()}.
              </p>
              <p className="text-sm text-slate-600 mt-0.5">
                If the underlying issue isn&rsquo;t actually resolved, reopen it.
                The reopen will be logged in the activity timeline.
              </p>
            </div>
            <form action={reopenFlagAction} className="shrink-0">
              <input type="hidden" name="property_id" value={property.id} />
              <input type="hidden" name="flag_id" value={flag.id} />
              <Button type="submit" variant="secondary" size="sm">
                <RotateCcw size={14} aria-hidden />
                Reopen
              </Button>
            </form>
          </div>
        </Card>
      ) : null}

      {/* Session 8: evidence photos. Sits above the activity timeline
          so the visual proof is the first thing a reader sees once
          they've grokked the triage state. The capture component is
          a client component (camera + canvas + uploads), everything
          else stays server-rendered. */}
      <section id="evidence" className="mb-8 scroll-mt-20">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">Evidence</h2>
            <p className="text-sm text-slate-600">
              Photos attached to this issue. Tap a thumbnail to open the full
              shot in a new tab. Captions are optional and editable.
            </p>
          </div>
          <EvidenceCapture
            propertyId={property.id}
            flagId={flag.id}
            launchLabel="Take photos"
          />
        </div>

        {photoRows.length === 0 ? (
          <Card>
            <div className="p-6 text-center">
              <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-slate-100 text-slate-600 mb-3">
                <Camera size={18} aria-hidden />
              </div>
              <p className="text-sm font-medium text-slate-800">
                No evidence photos yet
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Tap &ldquo;Take photos&rdquo; above. The camera stays open so you
                can capture multiple angles in a row.
              </p>
            </div>
          </Card>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {photoRows.map((photo) => (
              <EvidencePhotoTile
                key={photo.id}
                photo={photo}
                propertyId={property.id}
                flagId={flag.id}
                thumbUrl={
                  photo.thumbnail_path
                    ? thumbUrlMap[photo.thumbnail_path] ?? null
                    : null
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* Activity timeline */}
      <section id="activity" className="mb-8 scroll-mt-20">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Activity</h2>
            <p className="text-sm text-slate-600">
              State changes, notes, and reopens since this flag was raised.
            </p>
          </div>
        </div>

        <ol className="relative border-l-2 border-slate-200 ml-4 pl-6 space-y-5">
          {items.map((item, idx) => (
            <TimelineItem
              key={idx}
              item={item}
              idx={idx}
              currentUserId={currentUserId}
            />
          ))}
        </ol>

        {/* Add note form */}
        <Card className="mt-6">
          <div className="p-4 sm:p-5">
            <form action={addFlagNoteAction} className="space-y-3">
              <input type="hidden" name="property_id" value={property.id} />
              <input type="hidden" name="flag_id" value={flag.id} />
              <div className="flex items-start gap-2.5">
                <div className="shrink-0 p-2 rounded-md bg-slate-100">
                  <MessageSquare size={14} className="text-slate-700" aria-hidden />
                </div>
                <div className="flex-1">
                  <label htmlFor="note" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Add a note
                  </label>
                  <textarea
                    id="note"
                    name="note"
                    rows={3}
                    maxLength={2000}
                    placeholder='e.g. "Called Anil from maintenance. He&rsquo;ll come Tuesday morning."'
                    className="block w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 resize-y min-h-[5rem]"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm">Add note</Button>
              </div>
            </form>
          </div>
        </Card>
      </section>
    </AppShell>
  )
}

// ----------------------------------------------------------------
// Evidence photo tile (Session 8)
// ----------------------------------------------------------------
//
// Server-component. Renders a single thumbnail tile in the evidence
// grid with caption + per-tile actions (edit caption, soft-delete).
// The caption edit + delete buttons submit to server actions; the
// thumbnail itself is a link that opens the master in a new tab.
//
// Both URLs come from signed-url batch requests on the parent page —
// we never call createSignedUrl per render here. If the signed URL
// failed to issue (rare) we render a placeholder rather than a
// broken-image icon.
function EvidencePhotoTile({
  photo,
  propertyId,
  flagId,
  thumbUrl,
}: {
  photo: EvidencePhotoRow
  propertyId: string
  flagId: string
  thumbUrl: string | null
}) {
  const capturedDisplay = photo.captured_at ?? photo.uploaded_at
  // Anchor for the return_to: brings the user back to this exact
  // grid tile after a caption edit / delete.
  const returnTo = `/properties/${propertyId}/flags/${flagId}#evidence`
  // Click-to-view route signs the master on demand and 302s to
  // storage. Cheaper than pre-signing 20 master URLs at render.
  const viewHref = `/properties/${propertyId}/photos/${photo.id}/view`
  return (
    <li className="group relative rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
      {thumbUrl ? (
        <a
          href={viewHref}
          target="_blank"
          rel="noopener"
          aria-label="Open full photo"
          className="block aspect-square bg-slate-200"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbUrl}
            alt={photo.notes ?? 'Evidence photo'}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        </a>
      ) : (
        <div className="block aspect-square bg-slate-200 flex items-center justify-center text-slate-500 text-xs">
          Image unavailable
        </div>
      )}

      <div className="p-2 space-y-1.5">
        <details className="group/note">
          <summary className="list-none cursor-pointer">
            <p className="text-[11px] text-slate-700 line-clamp-2">
              {photo.notes ? (
                photo.notes
              ) : (
                <span className="italic text-slate-400">Tap to add caption</span>
              )}
            </p>
          </summary>
          <form action={updatePhotoNote} className="mt-1.5 space-y-1.5">
            <input type="hidden" name="property_id" value={propertyId} />
            <input type="hidden" name="flag_id" value={flagId} />
            <input type="hidden" name="photo_id" value={photo.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <textarea
              name="note"
              rows={2}
              defaultValue={photo.notes ?? ''}
              maxLength={2000}
              placeholder="Caption…"
              className="w-full px-2 py-1 text-[11px] text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 resize-y"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-slate-800 active:bg-slate-950 transition"
            >
              Save
            </button>
          </form>
        </details>
        <p className="text-[10px] text-slate-500">
          {formatDateTimeSAST(capturedDisplay)}
        </p>
      </div>

      <form
        action={softDeleteEvidencePhoto}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition"
      >
        <input type="hidden" name="property_id" value={propertyId} />
        <input type="hidden" name="flag_id" value={flagId} />
        <input type="hidden" name="photo_id" value={photo.id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <button
          type="submit"
          className="rounded-md bg-white/95 border border-slate-200 p-1 text-slate-600 hover:text-red-600 hover:border-red-200 shadow-sm transition"
          aria-label="Remove photo"
          title="Remove photo"
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </form>
    </li>
  )
}

// ----------------------------------------------------------------
// Flag activity timeline item
// ----------------------------------------------------------------
function TimelineItem({
  item,
  idx,
  currentUserId,
}: {
  item:
    | { kind: 'raised'; at: Date; actorId: string | null; description: string | null }
    | { kind: 'update'; at: Date; actorId: string | null; before: Record<string, unknown>; after: Record<string, unknown> }
    | { kind: 'note'; at: Date; actorId: string | null; note: string }
    | { kind: 'reopen'; at: Date; actorId: string | null }
  idx: number
  currentUserId: string
}) {
  const isYou = item.actorId === currentUserId
  const actorLabel = isYou ? 'You' : item.actorId ? 'Team member' : 'System'
  const when = relativeTime(item.at)

  return (
    <li key={idx} className="relative">
      <span
        className={
          item.kind === 'note'
            ? 'absolute -left-[34px] mt-1 w-4 h-4 rounded-full bg-white border-2 border-slate-300'
            : item.kind === 'reopen'
            ? 'absolute -left-[34px] mt-1 w-4 h-4 rounded-full bg-amber-100 border-2 border-amber-400'
            : item.kind === 'raised'
            ? 'absolute -left-[34px] mt-1 w-4 h-4 rounded-full bg-slate-900 border-2 border-slate-900'
            : 'absolute -left-[34px] mt-1 w-4 h-4 rounded-full bg-slate-100 border-2 border-slate-400'
        }
        aria-hidden
      />
      {item.kind === 'raised' && (
        <div>
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{actorLabel}</span> raised this flag
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">{when}</p>
        </div>
      )}
      {item.kind === 'update' && (
        <div>
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{actorLabel}</span> updated this flag
          </p>
          <ul className="mt-1 space-y-0.5">
            {summarizeUpdate(item.before, item.after).map((line, i) => (
              <li key={i} className="text-sm text-slate-700">
                <span className="inline-block w-1 h-1 rounded-full bg-slate-400 align-middle mr-2" />
                {line}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-500 mt-1">{when}</p>
        </div>
      )}
      {item.kind === 'note' && (
        <div>
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{actorLabel}</span> added a note
          </p>
          <p className="mt-1 text-sm text-slate-800 whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-md p-2.5">
            {item.note}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">{when}</p>
        </div>
      )}
      {item.kind === 'reopen' && (
        <div>
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{actorLabel}</span> reopened this flag
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">{when}</p>
        </div>
      )}
    </li>
  )
}

function summarizeUpdate(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const out: string[] = []
  const statusBefore = typeof before.status === 'string' ? before.status : null
  const statusAfter = typeof after.status === 'string' ? after.status : null
  if (statusBefore && statusAfter && statusBefore !== statusAfter) {
    out.push(
      `Status: ${flagStatusDisplay(statusBefore).label} → ${flagStatusDisplay(statusAfter).label}`,
    )
  }
  const sevBefore = typeof before.severity === 'string' ? before.severity : null
  const sevAfter = typeof after.severity === 'string' ? after.severity : null
  if (sevBefore && sevAfter && sevBefore !== sevAfter) {
    out.push(
      `Severity: ${severityDisplay(sevBefore).label} → ${severityDisplay(sevAfter).label}`,
    )
  }
  const cpBefore = before.chargeable_party_decision
  const cpAfter = after.chargeable_party_decision
  const cpBeforeStr = typeof cpBefore === 'string' ? cpBefore : null
  const cpAfterStr = typeof cpAfter === 'string' ? cpAfter : null
  if (cpBefore !== cpAfter) {
    out.push(
      `Responsibility: ${chargeablePartyDisplay(cpBeforeStr).label} → ${chargeablePartyDisplay(cpAfterStr).label}`,
    )
  }
  const narBefore = typeof before.no_action_reason === 'string' ? before.no_action_reason : null
  const narAfter = typeof after.no_action_reason === 'string' ? after.no_action_reason : null
  if (narBefore !== narAfter && narAfter) {
    out.push(`Close reason set: "${narAfter}"`)
  }
  if (out.length === 0) {
    out.push('No visible change')
  }
  return out
}

// ----------------------------------------------------------------
// Recovery task card (inline on flag detail page)
// ----------------------------------------------------------------
function RecoveryTaskCard({
  task,
  stay,
  attempts,
  propertyId,
  flagId,
  propertyName,
  companyName,
  flagDescription,
  currentUserId,
}: {
  task: RecoveryTask
  stay: StayEmbed | null
  attempts: RecoveryAttempt[]
  propertyId: string
  flagId: string
  propertyName: string
  companyName: string
  flagDescription: string | null
  currentUserId: string
}) {
  const taskStatus = recoveryStatusDisplay(task.status)
  const estimated = asNumber(task.estimated_amount)
  const actual = asNumber(task.actual_amount)
  const StatusIcon = taskStatus.icon

  const messageDescription = task.description ?? flagDescription ?? null
  const guestFirstName = stay?.guest_first_name ?? 'there'
  const message = buildRecoveryMessage({
    guestFirstName,
    propertyName,
    companyName,
    description: messageDescription,
    estimatedAmount: estimated,
  })
  const whatsappUrl = buildWhatsAppUrl(stay?.guest_phone ?? null, message)

  return (
    <Card>
      <div className="p-5">
        {/* Header: guest info + status badge */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">Recovery task</p>
            <h3 className="text-base font-semibold text-slate-900 truncate">
              {stay?.guest_first_name ?? 'Unknown guest'}
            </h3>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
              {stay?.guest_phone ? (
                <a
                  href={`tel:${stay.guest_phone}`}
                  className="text-sm text-slate-700 hover:text-slate-900 hover:underline"
                >
                  {stay.guest_phone}
                </a>
              ) : (
                <span className="text-sm text-slate-400 italic">No phone</span>
              )}
              {stay?.guest_email ? (
                <a
                  href={`mailto:${stay.guest_email}`}
                  className="text-sm text-slate-600 hover:text-slate-900 hover:underline"
                >
                  {stay.guest_email}
                </a>
              ) : null}
            </div>
          </div>
          <Badge tone={taskStatus.tone}>
            <StatusIcon size={11} className="mr-1 -ml-0.5" aria-hidden />
            {taskStatus.label}
          </Badge>
        </div>

        {/* Amounts + deadline */}
        <dl className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-100">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Estimated</dt>
            <dd className="text-sm font-medium text-slate-900 mt-0.5 tabular-nums">
              {estimated != null ? formatZAR(estimated) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Actual</dt>
            <dd className="text-sm font-medium text-slate-900 mt-0.5 tabular-nums">
              {actual != null ? formatZAR(actual) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Deadline</dt>
            <dd className="text-sm font-medium text-slate-900 mt-0.5">
              {relativeTimeUntil(task.deadline_at)}
            </dd>
          </div>
        </dl>

        {/* Description */}
        {task.description ? (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Incident</p>
            <p className="text-sm text-slate-700 leading-snug whitespace-pre-wrap">{task.description}</p>
          </div>
        ) : null}

        {/* Actions */}
        <div className="mt-4 pt-4 border-t border-slate-100">
          <RecoveryActions
            task={task}
            whatsappUrl={whatsappUrl}
            message={message}
            propertyId={propertyId}
            flagId={flagId}
            estimatedAmount={estimated}
          />
        </div>

        {/* Mini timeline */}
        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-[10px] font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
            Recovery activity
          </p>
          <ol className="space-y-2.5">
            <li className="flex items-start gap-2 text-sm">
              <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-900" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-slate-700">
                  <span className="font-medium text-slate-900">
                    {task.created_by === currentUserId ? 'You' : 'Team member'}
                  </span>{' '}
                  created the recovery task
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {relativeTime(task.created_at)}
                </p>
              </div>
            </li>
            {attempts
              .slice()
              .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
              .map((a) => {
                const outcome = outcomeDisplay(a.outcome)
                const isYou = a.recorded_by === currentUserId
                const actorLabel = isYou ? 'You' : a.recorded_by ? 'Team member' : 'System'
                return (
                  <li key={a.id} className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-400" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-slate-700">
                        <span className="font-medium text-slate-900">{actorLabel}</span>{' '}
                        {summarizeAttempt(a)}
                      </p>
                      {a.notes ? (
                        <p className="mt-1 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded p-2">
                          {a.notes}
                        </p>
                      ) : null}
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge tone={outcome.tone}>{outcome.label}</Badge>
                        <span className="text-[11px] text-slate-500">{relativeTime(a.recorded_at)}</span>
                      </div>
                    </div>
                  </li>
                )
              })}
          </ol>
        </div>
      </div>
    </Card>
  )
}

function summarizeAttempt(a: RecoveryAttempt): string {
  if (a.attempt_method === 'whatsapp_deeplink' || a.attempt_method === 'whatsapp') {
    return 'sent the WhatsApp message'
  }
  if (a.outcome === 'paid_full' || a.outcome === 'paid_partial') {
    const amount = asNumber(a.amount_recovered)
    return amount != null
      ? `marked the guest paid (${formatZAR(amount)})`
      : 'marked the guest paid'
  }
  if (a.outcome === 'refused') {
    return 'marked the guest refused'
  }
  if (a.outcome === 'no_response') {
    return 'recorded no response'
  }
  return 'recorded an attempt'
}

// ----------------------------------------------------------------
// Recovery action buttons (status-dependent)
// ----------------------------------------------------------------
function RecoveryActions({
  task,
  whatsappUrl,
  message,
  propertyId,
  flagId,
  estimatedAmount,
}: {
  task: RecoveryTask
  whatsappUrl: string | null
  message: string
  propertyId: string
  flagId: string
  estimatedAmount: number | null
}) {
  const taskId = task.id

  if (task.status === 'new') {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        {whatsappUrl ? (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClasses('secondary', 'sm')}
          >
            <MessageCircle size={14} aria-hidden />
            Open WhatsApp
          </a>
        ) : (
          <span className="text-xs text-slate-500 italic">No phone on file — can&rsquo;t open WhatsApp.</span>
        )}
        <form action={markGuestNotifiedAction}>
          <input type="hidden" name="property_id" value={propertyId} />
          <input type="hidden" name="flag_id" value={flagId} />
          <input type="hidden" name="task_id" value={taskId} />
          <input type="hidden" name="message_body" value={message} />
          <Button type="submit" size="sm">Mark guest notified</Button>
        </form>
        <p className="text-[11px] text-slate-500 w-full mt-1">
          Open WhatsApp sends nothing on its own — confirm with &ldquo;Mark guest notified&rdquo; after you send.
        </p>
      </div>
    )
  }

  if (task.status === 'guest_notified') {
    return (
      <div className="space-y-3">
        {whatsappUrl ? (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-600 hover:text-slate-900 hover:underline inline-flex items-center gap-1"
          >
            <MessageCircle size={12} aria-hidden />
            Open WhatsApp again
          </a>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <form action={markGuestPaidAction} className="flex items-end gap-2">
            <input type="hidden" name="property_id" value={propertyId} />
            <input type="hidden" name="flag_id" value={flagId} />
            <input type="hidden" name="task_id" value={taskId} />
            <div>
              <label
                htmlFor={`amount-${taskId}`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Amount paid (R)
              </label>
              <input
                id={`amount-${taskId}`}
                name="amount_recovered"
                type="number"
                min={0}
                step="any"
                required
                defaultValue={estimatedAmount ?? ''}
                className="block w-32 h-9 px-2.5 text-sm text-slate-900 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
              />
            </div>
            <Button type="submit" size="sm">Mark paid</Button>
          </form>
          <form action={markGuestRefusedAction}>
            <input type="hidden" name="property_id" value={propertyId} />
            <input type="hidden" name="flag_id" value={flagId} />
            <input type="hidden" name="task_id" value={taskId} />
            <Button type="submit" size="sm" variant="secondary">Mark refused</Button>
          </form>
        </div>
      </div>
    )
  }

  if (task.status === 'guest_resolved' || task.status === 'fallback_decision') {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        <form action={closeRecoveryTaskAction}>
          <input type="hidden" name="property_id" value={propertyId} />
          <input type="hidden" name="flag_id" value={flagId} />
          <input type="hidden" name="task_id" value={taskId} />
          <Button type="submit" size="sm" variant="secondary">Close recovery task</Button>
        </form>
        {task.status === 'fallback_decision' ? (
          <span className="text-xs text-slate-500">
            OTA claim and company-absorb fallback ship in v1.1.
          </span>
        ) : null}
      </div>
    )
  }

  // closed / ota_*  → read-only summary
  return (
    <p className="text-xs text-slate-500">
      This recovery task is {recoveryStatusDisplay(task.status).label.toLowerCase()}.
    </p>
  )
}
