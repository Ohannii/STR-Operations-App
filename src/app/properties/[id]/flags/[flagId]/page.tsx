import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  Flag as FlagIcon,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonClasses } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { RadioChip } from '@/components/ui/chip'
import { Field } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  getFlagCategoryDisplay,
  severityDisplay,
} from '@/lib/ui/flag-category'
import {
  CHARGEABLE_PARTIES,
  chargeablePartyDisplay,
  FLAG_STATUSES,
  flagStatusDisplay,
  isTerminalStatus,
} from '@/lib/ui/flag-status'
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
import {
  closeRecoveryTaskAction,
  markGuestNotifiedAction,
  markGuestPaidAction,
  markGuestRefusedAction,
} from './recovery/[taskId]/actions'

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
  chargeable_party_decision: string | null
  no_action_reason: string | null
  raised_at: string
  raised_by: string
  classified_at: string | null
  classified_by: string | null
  actioned_at: string | null
  closed_at: string | null
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
      chargeable_party_decision,
      no_action_reason,
      raised_at,
      raised_by,
      classified_at,
      classified_by,
      actioned_at,
      closed_at,
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

  const [
    { data: property },
    { data: flag },
    { data: auditEvents },
    { data: recoveryRows },
  ] = await Promise.all([propertyPromise, flagPromise, auditPromise, recoveryPromise])

  if (!property || !flag) notFound()

  const categoryRow = pickEmbedded(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
  const status = flagStatusDisplay(flag.status)
  const sev = severityDisplay(flag.severity)
  const charge = chargeablePartyDisplay(flag.chargeable_party_decision)
  const isClosed = isTerminalStatus(flag.status)
  const currentUserId = ctx.user.id
  const CatIcon: LucideIcon = cat?.icon ?? FlagIcon

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
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">Flag</p>
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
                {cat?.label ?? 'Flag'}
              </h1>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Badge tone={status.tone}>{status.label}</Badge>
                <Badge tone={sev.tone}>{sev.label}</Badge>
                <Badge tone={charge.tone}>Responsibility: {charge.label}</Badge>
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
                  const checked =
                    (flag.chargeable_party_decision ?? 'pending_decision') === p
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
                This flag is {status.label.toLowerCase()}.
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
