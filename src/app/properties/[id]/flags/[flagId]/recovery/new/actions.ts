'use server'

import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'

/**
 * Server action for /properties/[id]/flags/[flagId]/recovery/new.
 * Calls the create_recovery_task_from_flag RPC which atomically
 * creates a minimal stay + the recovery task and (if not set)
 * defaults the flag's chargeable_party_decision to 'guest'.
 *
 * Errors flow back via ?error= keeping the form values where
 * possible. Server-side console.error captures the underlying
 * cause for terminal visibility.
 */
export async function createRecoveryTaskAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()

  const formUrl = `/properties/${propertyId}/flags/${flagId}/recovery/new`

  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }

  const guestFirstName = String(formData.get('guest_first_name') ?? '').trim()
  const guestPhone = String(formData.get('guest_phone') ?? '').trim()
  const guestEmail = String(formData.get('guest_email') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const estimatedStr = String(formData.get('estimated_amount') ?? '').trim()
  const deadlineHoursStr = String(formData.get('deadline_hours') ?? '48').trim()

  if (!guestFirstName) {
    redirect(`${formUrl}?error=${encodeURIComponent('Guest first name is required.')}`)
  }
  if (!guestPhone) {
    redirect(`${formUrl}?error=${encodeURIComponent('Guest phone number is required (for WhatsApp).')}`)
  }
  if (guestPhone.replace(/[^\d]/g, '').length < 7) {
    redirect(
      `${formUrl}?error=${encodeURIComponent(
        'Phone number looks too short. Include the country code (e.g. +27...).',
      )}`,
    )
  }

  let estimatedAmount: number | null = null
  if (estimatedStr) {
    estimatedAmount = Number(estimatedStr)
    if (isNaN(estimatedAmount) || estimatedAmount < 0) {
      redirect(`${formUrl}?error=${encodeURIComponent('Estimated amount must be a non-negative number.')}`)
    }
  }

  const deadlineHours = Number(deadlineHoursStr)
  if (isNaN(deadlineHours) || deadlineHours < 1 || deadlineHours > 720) {
    redirect(
      `${formUrl}?error=${encodeURIComponent('Deadline must be between 1 hour and 30 days.')}`,
    )
  }

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  const { data: taskId, error: rpcErr } = await supabase.rpc(
    'create_recovery_task_from_flag',
    {
      p_flag_id: flagId,
      p_guest_first_name: guestFirstName,
      p_guest_phone: guestPhone,
      p_guest_email: guestEmail || null,
      p_estimated_amount: estimatedAmount,
      p_description: description || null,
      p_deadline_hours: deadlineHours,
    },
  )

  if (rpcErr) {
    console.error('[recovery/new] RPC error:', rpcErr)
    redirect(
      `${formUrl}?error=${encodeURIComponent(
        `Could not create recovery task: ${rpcErr.message}`,
      )}`,
    )
  }

  if (!taskId) {
    console.error('[recovery/new] RPC returned no task id')
    redirect(`${formUrl}?error=${encodeURIComponent('Could not create recovery task. Try again.')}`)
  }

  redirect(`/properties/${propertyId}/flags/${flagId}?recovery_created=1#recovery`)
}
