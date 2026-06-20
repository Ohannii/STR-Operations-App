'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import {
  CHARGEABLE_PARTIES,
  FLAG_STATUSES,
  isTerminalStatus,
  type FlagStatus,
  type ChargeableParty,
} from '@/lib/ui/flag-status'

const SEVERITIES = ['low', 'med', 'high'] as const

/**
 * Server actions for the flag detail page at
 * /properties/[id]/flags/[flagId].
 *
 * All three actions write to the audit_events log so the activity
 * timeline can render the change history. RLS on audit_events
 * scopes both writes and reads to the user's company.
 *
 * Diagnostics: errors flow back via ?error= query string with
 * server-side console.error for the underlying cause.
 */

// Minimal current-flag shape we read for before/after diffing.
type FlagSnapshot = {
  status: string
  severity: string
  chargeable_party_decision: string | null
  no_action_reason: string | null
  closed_at: string | null
  classified_at: string | null
  actioned_at: string | null
  classified_by: string | null
}

// ----------------------------------------------------------------
// updateFlagAction — status / severity / responsibility / close-reason
// ----------------------------------------------------------------
export async function updateFlagAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  // Session 7: optional return_to lets the Action Centre's inline
  // Mark Resolved form land back on the Action Centre instead of
  // the flag detail page. safeReturnTo enforces an internal path
  // scoped to /properties/{propertyId} -- this rejects
  // protocol-relative URLs (//evil.com), absolute schemes
  // (http://, https://), backslash tricks, and any path outside
  // the current property.
  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }

  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)

  const detailUrl = `/properties/${propertyId}/flags/${flagId}`

  const newStatus = String(formData.get('status') ?? '').trim()
  const newSeverity = String(formData.get('severity') ?? '').trim()
  const newChargeable = String(formData.get('chargeable_party_decision') ?? '').trim()
  const noActionReasonRaw = String(formData.get('no_action_reason') ?? '').trim()
  const noActionReason = noActionReasonRaw.length > 0 ? noActionReasonRaw : null

  // Validate
  if (!FLAG_STATUSES.includes(newStatus as FlagStatus)) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Invalid status.')}`)
  }
  if (!SEVERITIES.includes(newSeverity as (typeof SEVERITIES)[number])) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Invalid severity.')}`)
  }
  if (!CHARGEABLE_PARTIES.includes(newChargeable as ChargeableParty)) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Invalid responsibility.')}`)
  }
  if (newStatus === 'no_action' && !noActionReason) {
    redirect(
      `${detailUrl}?error=${encodeURIComponent('A reason is required when closing as "No action".')}`,
    )
  }
  if (noActionReason && noActionReason.length > 1000) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Reason is too long (max 1000).')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  const { data: current, error: readErr } = await supabase
    .from('flags')
    .select(
      `status, severity, chargeable_party_decision, no_action_reason,
       closed_at, classified_at, actioned_at, classified_by`,
    )
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<FlagSnapshot>()

  if (readErr) {
    console.error('[flag/update] read error:', readErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(readErr.message)}`)
  }
  if (!current) {
    redirect(`/properties/${propertyId}?error=${encodeURIComponent('Flag not found.')}`)
  }

  // Build the update.
  // - On any status change, sync the lifecycle timestamps (idempotent:
  //   once set, classified_at / actioned_at / closed_at stay set;
  //   re-classifying after re-opening just keeps the original timestamp).
  // - On transition INTO no_action / closed, set closed_at if not set.
  // - On transition OUT of no_action / closed, the reopenFlagAction
  //   path handles the clear; updateFlagAction never clears them.
  const now = new Date().toISOString()
  const update: Record<string, unknown> = {
    status: newStatus,
    severity: newSeverity,
    chargeable_party_decision: newChargeable,
    no_action_reason: newStatus === 'no_action' ? noActionReason : null,
  }
  if (newStatus === 'classified' && !current.classified_at) {
    update.classified_at = now
    update.classified_by = ctx.user.id
  }
  if (newStatus === 'actioned' && !current.actioned_at) {
    update.actioned_at = now
  }
  if (isTerminalStatus(newStatus) && !current.closed_at) {
    update.closed_at = now
  }

  // Detect whether anything actually changed; skip the write if not.
  const changedFields = (
    ['status', 'severity', 'chargeable_party_decision', 'no_action_reason'] as const
  ).filter((k) => current[k] !== (update[k] ?? null))

  if (changedFields.length === 0) {
    redirect(`${detailUrl}?error=${encodeURIComponent('No changes to save.')}`)
  }

  const { error: updateErr } = await supabase
    .from('flags')
    .update(update)
    .eq('id', flagId)

  if (updateErr) {
    console.error('[flag/update] update error:', updateErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(updateErr.message)}`)
  }

  // Append a structured audit event so the activity log can render
  // a clean before/after diff later.
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of changedFields) {
    before[key] = current[key]
    after[key] = update[key]
  }
  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: ctx.company.id,
    actor_id: ctx.user.id,
    event_kind: 'flag_update',
    entity_type: 'flag',
    entity_id: flagId,
    before,
    after,
  })
  if (auditErr) {
    // Don't surface to the user -- the flag update succeeded. Log
    // server-side and continue.
    console.error('[flag/update] audit write failed:', auditErr)
  }

  // Session 8 fix: explicit cache invalidation. Without this, the
  // Action Centre at /properties/[id] may serve a stale RSC payload
  // after the redirect — closed flags show as still-open in the
  // Open Flags list. The action's "home" route is the flag detail
  // page; the Action Centre + company dashboard are different
  // routes that must be invalidated explicitly so the open-flags
  // counts on both stay correct after a resolve / reopen.
  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/flags/${flagId}`)
  revalidatePath('/dashboard')

  // Session 7: return_to (when present and safe) wins over the
  // default detail-page redirect. The Action Centre's inline Mark
  // Resolved sends a return URL back to the apartment dashboard.
  if (returnTo) {
    redirect(returnTo)
  }
  redirect(`${detailUrl}?updated=1#activity`)
}

// ----------------------------------------------------------------
// addFlagNoteAction — append an operational note
// ----------------------------------------------------------------
export async function addFlagNoteAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()

  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }

  const detailUrl = `/properties/${propertyId}/flags/${flagId}`

  if (!note) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Type something before adding the note.')}`)
  }
  if (note.length > 2000) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Note is too long (max 2000 characters).')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  const { error } = await supabase.from('audit_events').insert({
    company_id: ctx.company.id,
    actor_id: ctx.user.id,
    event_kind: 'flag_note',
    entity_type: 'flag',
    entity_id: flagId,
    metadata: { note },
  })

  if (error) {
    console.error('[flag/note] insert error:', error)
    redirect(`${detailUrl}?error=${encodeURIComponent(error.message)}`)
  }

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/flags/${flagId}`)

  redirect(`${detailUrl}?note_added=1#activity`)
}

// ----------------------------------------------------------------
// reopenFlagAction — flips a terminal flag back to 'raised'
// ----------------------------------------------------------------
export async function reopenFlagAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()

  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }

  const detailUrl = `/properties/${propertyId}/flags/${flagId}`

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  const { data: current, error: readErr } = await supabase
    .from('flags')
    .select('status, closed_at, no_action_reason')
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{
      status: string
      closed_at: string | null
      no_action_reason: string | null
    }>()

  if (readErr) {
    console.error('[flag/reopen] read error:', readErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(readErr.message)}`)
  }
  if (!current) {
    redirect(`/properties/${propertyId}?error=${encodeURIComponent('Flag not found.')}`)
  }
  if (!isTerminalStatus(current.status)) {
    redirect(
      `${detailUrl}?error=${encodeURIComponent('Only closed or no-action flags can be reopened.')}`,
    )
  }

  const { error: updateErr } = await supabase
    .from('flags')
    .update({
      status: 'raised',
      closed_at: null,
      no_action_reason: null,
    })
    .eq('id', flagId)

  if (updateErr) {
    console.error('[flag/reopen] update error:', updateErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(updateErr.message)}`)
  }

  const { error: auditErr } = await supabase.from('audit_events').insert({
    company_id: ctx.company.id,
    actor_id: ctx.user.id,
    event_kind: 'flag_reopen',
    entity_type: 'flag',
    entity_id: flagId,
    before: {
      status: current.status,
      closed_at: current.closed_at,
      no_action_reason: current.no_action_reason,
    },
    after: { status: 'raised', closed_at: null, no_action_reason: null },
  })
  if (auditErr) {
    console.error('[flag/reopen] audit write failed:', auditErr)
  }

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/flags/${flagId}`)
  revalidatePath('/dashboard')

  redirect(`${detailUrl}?reopened=1#activity`)
}
