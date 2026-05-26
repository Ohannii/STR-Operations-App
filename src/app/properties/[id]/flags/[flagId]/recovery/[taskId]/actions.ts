'use server'

import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'

/**
 * Server actions for an EXISTING guest_recovery_task.
 *
 * Four transitions ship in Session 5:
 *   - markGuestNotifiedAction      → new -> guest_notified
 *   - markGuestPaidAction          → guest_notified -> guest_resolved
 *   - markGuestRefusedAction       → guest_notified -> fallback_decision
 *   - closeRecoveryTaskAction      → any -> closed
 *
 * Each transition writes a row to recovery_attempts so the
 * activity history is complete. RLS scopes both the task update
 * and the attempt insert to company members.
 *
 * The OTA-claim path (fallback_decision -> ota_attempted ->
 * ota_resolved) is intentionally not implemented yet -- ships
 * with v1.1 polish per GUEST_DAMAGE_RECOVERY_WORKFLOW.md.
 */

type RecoveryTaskSnapshot = {
  id: string
  status: string
  estimated_amount: number | string | null
}

function detailUrl(propertyId: string, flagId: string, suffix: string = '') {
  return `/properties/${propertyId}/flags/${flagId}${suffix}#recovery`
}

async function readTask(taskId: string) {
  const supabase = await createClient()
  return supabase
    .from('guest_recovery_tasks')
    .select('id, status, estimated_amount')
    .eq('id', taskId)
    .is('deleted_at', null)
    .maybeSingle<RecoveryTaskSnapshot>()
}

// ----------------------------------------------------------------
// markGuestNotifiedAction
// ----------------------------------------------------------------
export async function markGuestNotifiedAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const taskId = String(formData.get('task_id') ?? '').trim()
  const messageBody = String(formData.get('message_body') ?? '').trim()

  if (!propertyId || !flagId || !taskId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing recovery task reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { data: task, error: readErr } = await readTask(taskId)
  if (readErr) {
    console.error('[recovery/notified] read error:', readErr)
    redirect(`${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(readErr.message)}`)}`)
  }
  if (!task) {
    redirect(`${detailUrl(propertyId, flagId, `?error=${encodeURIComponent('Recovery task not found.')}`)}`)
  }

  const supabase = await createClient()
  const now = new Date().toISOString()

  const [attemptResult, updateResult] = await Promise.all([
    supabase.from('recovery_attempts').insert({
      task_id: taskId,
      attempt_type: 'guest_direct',
      attempt_method: 'whatsapp_deeplink',
      message_sent_at: now,
      message_body_snapshot: messageBody || null,
      outcome: 'pending',
      recorded_by: ctx.user.id,
    }),
    supabase
      .from('guest_recovery_tasks')
      .update({ status: 'guest_notified' })
      .eq('id', taskId),
  ])

  if (attemptResult.error) {
    console.error('[recovery/notified] attempt insert error:', attemptResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(attemptResult.error.message)}`)}`,
    )
  }
  if (updateResult.error) {
    console.error('[recovery/notified] task update error:', updateResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(updateResult.error.message)}`)}`,
    )
  }

  redirect(`${detailUrl(propertyId, flagId, '?notified=1')}`)
}

// ----------------------------------------------------------------
// markGuestPaidAction
// ----------------------------------------------------------------
export async function markGuestPaidAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const taskId = String(formData.get('task_id') ?? '').trim()
  const amountStr = String(formData.get('amount_recovered') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim()

  if (!propertyId || !flagId || !taskId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing recovery task reference.')}`)
  }
  if (!amountStr) {
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent('Enter the amount the guest paid.')}`)}`,
    )
  }

  const rawAmount = Number(amountStr)
  if (isNaN(rawAmount) || rawAmount < 0) {
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent('Amount must be a non-negative number.')}`)}`,
    )
  }
  // Round to 2 decimals via integer arithmetic; same FP defence as
  // the recovery create action and formatZAR.
  const amount = Math.round(rawAmount * 100) / 100

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { data: task, error: readErr } = await readTask(taskId)
  if (readErr) {
    console.error('[recovery/paid] read error:', readErr)
    redirect(`${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(readErr.message)}`)}`)
  }
  if (!task) {
    redirect(`${detailUrl(propertyId, flagId, `?error=${encodeURIComponent('Recovery task not found.')}`)}`)
  }

  const estimated = task.estimated_amount != null ? Number(task.estimated_amount) : null
  const outcome =
    estimated != null && amount + 0.001 < estimated ? 'paid_partial' : 'paid_full'

  const supabase = await createClient()

  const [attemptResult, updateResult] = await Promise.all([
    supabase.from('recovery_attempts').insert({
      task_id: taskId,
      attempt_type: 'guest_direct',
      attempt_method: 'app_decision',
      outcome,
      amount_recovered: amount,
      notes: notes || null,
      recorded_by: ctx.user.id,
    }),
    supabase
      .from('guest_recovery_tasks')
      .update({
        status: 'guest_resolved',
        actual_amount: amount,
        final_chargeable_party: 'guest',
      })
      .eq('id', taskId),
  ])

  if (attemptResult.error) {
    console.error('[recovery/paid] attempt insert error:', attemptResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(attemptResult.error.message)}`)}`,
    )
  }
  if (updateResult.error) {
    console.error('[recovery/paid] task update error:', updateResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(updateResult.error.message)}`)}`,
    )
  }

  redirect(`${detailUrl(propertyId, flagId, '?paid=1')}`)
}

// ----------------------------------------------------------------
// markGuestRefusedAction
// ----------------------------------------------------------------
export async function markGuestRefusedAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const taskId = String(formData.get('task_id') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim()

  if (!propertyId || !flagId || !taskId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing recovery task reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  const [attemptResult, updateResult] = await Promise.all([
    supabase.from('recovery_attempts').insert({
      task_id: taskId,
      attempt_type: 'guest_direct',
      attempt_method: 'app_decision',
      outcome: 'refused',
      notes: notes || null,
      recorded_by: ctx.user.id,
    }),
    supabase
      .from('guest_recovery_tasks')
      .update({ status: 'fallback_decision' })
      .eq('id', taskId),
  ])

  if (attemptResult.error) {
    console.error('[recovery/refused] attempt insert error:', attemptResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(attemptResult.error.message)}`)}`,
    )
  }
  if (updateResult.error) {
    console.error('[recovery/refused] task update error:', updateResult.error)
    redirect(
      `${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(updateResult.error.message)}`)}`,
    )
  }

  redirect(`${detailUrl(propertyId, flagId, '?refused=1')}`)
}

// ----------------------------------------------------------------
// closeRecoveryTaskAction
// ----------------------------------------------------------------
export async function closeRecoveryTaskAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const taskId = String(formData.get('task_id') ?? '').trim()

  if (!propertyId || !flagId || !taskId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing recovery task reference.')}`)
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()
  const now = new Date().toISOString()

  const { error } = await supabase
    .from('guest_recovery_tasks')
    .update({
      status: 'closed',
      closed_at: now,
    })
    .eq('id', taskId)

  if (error) {
    console.error('[recovery/close] update error:', error)
    redirect(`${detailUrl(propertyId, flagId, `?error=${encodeURIComponent(error.message)}`)}`)
  }

  redirect(`${detailUrl(propertyId, flagId, '?closed=1')}`)
}
