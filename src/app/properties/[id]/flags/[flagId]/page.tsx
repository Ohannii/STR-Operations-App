import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  Flag as FlagIcon,
  MessageSquare,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { relativeTime } from '@/lib/ui/relative-time'
import {
  addFlagNoteAction,
  reopenFlagAction,
  updateFlagAction,
} from './actions'

/**
 * GET /properties/[id]/flags/[flagId]
 *
 * Flag detail + triage view. Sections:
 *   1. Header card -- category, severity, status, responsibility,
 *      description.
 *   2. Triage form -- radio chips for status / severity /
 *      responsibility, plus an optional close-reason text input
 *      that's required only when closing as "No action".
 *   3. Activity timeline -- combined view of the implicit
 *      lifecycle (raised by X) plus audit_events rows (status
 *      changes, notes, reopens) in chronological order.
 *   4. Add-note form.
 *   5. Reopen affordance (visible only for closed / no_action flags).
 *
 * Data loaded in parallel: property + flag + audit_events. RLS
 * scopes all three to the user's company.
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

function pickEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
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
    error?: string
  }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId, flagId } = await params
  const { updated, note_added, reopened, error } = await searchParams

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

  const [{ data: property }, { data: flag }, { data: auditEvents }] =
    await Promise.all([propertyPromise, flagPromise, auditPromise])

  if (!property || !flag) notFound()

  const categoryRow = pickEmbedded(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
  const status = flagStatusDisplay(flag.status)
  const sev = severityDisplay(flag.severity)
  const charge = chargeablePartyDisplay(flag.chargeable_party_decision)
  const isClosed = isTerminalStatus(flag.status)
  const currentUserId = ctx.user.id
  const CatIcon: LucideIcon = cat?.icon ?? FlagIcon

  // Build the activity timeline.
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
              key={'k' in item ? '' : idx}
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
// Internal: a single timeline row.
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
