'use server'

import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import {
  ALL_CHIP_KINDS,
  getChipDisplay,
  type ChipKind,
} from '@/lib/ui/chip-vocabulary'

/**
 * Server action invoked by the chip toggle buttons on the flag
 * detail page.
 *
 * Semantics:
 *   - If an active mark of this kind already exists on this flag,
 *     it gets cleared (cleared_at = now(), cleared_by = user).
 *     History row is preserved.
 *   - If no active mark exists, a new row is inserted. The chip's
 *     `replaces` array (e.g., maintenance_done replaces both
 *     maintenance_pending and maintenance_assigned) is processed
 *     first — any active marks of those kinds are cleared in the
 *     same action.
 *
 * RLS enforces company scope; the partial unique index on
 * (flag_id, kind) where cleared_at is null prevents duplicate
 * active marks even under concurrent clicks.
 */
export async function toggleFlagMarkAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const kindRaw = String(formData.get('kind') ?? '').trim()

  const detailUrl = `/properties/${propertyId}/flags/${flagId}`

  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }
  if (!ALL_CHIP_KINDS.includes(kindRaw as ChipKind)) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Unknown chip kind.')}#operational`)
  }
  const kind = kindRaw as ChipKind

  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()

  // Verify the flag exists and the caller can read it (RLS does the
  // actual scope check). Pull company_id for the insert path.
  const { data: flag, error: flagErr } = await supabase
    .from('flags')
    .select('id, company_id')
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string }>()

  if (flagErr) {
    console.error('[marks/toggle] flag read error:', flagErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(flagErr.message)}#operational`)
  }
  if (!flag) {
    redirect(`${detailUrl}?error=${encodeURIComponent('Flag not found.')}#operational`)
  }

  // Check current state of this chip.
  const { data: existing, error: readErr } = await supabase
    .from('flag_operational_marks')
    .select('id')
    .eq('flag_id', flagId)
    .eq('kind', kind)
    .is('cleared_at', null)
    .limit(1)

  if (readErr) {
    console.error('[marks/toggle] active-check error:', readErr)
    redirect(`${detailUrl}?error=${encodeURIComponent(readErr.message)}#operational`)
  }

  const isActive = (existing?.length ?? 0) > 0
  const now = new Date().toISOString()

  if (isActive) {
    // Toggle OFF: clear the active mark.
    const { error: clearErr } = await supabase
      .from('flag_operational_marks')
      .update({
        cleared_at: now,
        cleared_by: ctx.user.id,
      })
      .eq('flag_id', flagId)
      .eq('kind', kind)
      .is('cleared_at', null)

    if (clearErr) {
      console.error('[marks/toggle] clear error:', clearErr)
      redirect(`${detailUrl}?error=${encodeURIComponent(clearErr.message)}#operational`)
    }
  } else {
    // Toggle ON: first clear any predecessors per the `replaces` list,
    // then insert the new mark.
    const chip = getChipDisplay(kind)
    if (chip?.replaces && chip.replaces.length > 0) {
      const { error: replaceErr } = await supabase
        .from('flag_operational_marks')
        .update({
          cleared_at: now,
          cleared_by: ctx.user.id,
        })
        .eq('flag_id', flagId)
        .in('kind', chip.replaces)
        .is('cleared_at', null)
      if (replaceErr) {
        // Predecessor clearing failure is non-fatal — we can still
        // record the new mark. Log it and continue. The partial unique
        // index protects against duplicate active rows; if a
        // predecessor stayed active, the insert below may fail with
        // a constraint violation, which the user will see clearly.
        console.error('[marks/toggle] predecessor clear error:', replaceErr)
      }
    }

    const { error: insertErr } = await supabase
      .from('flag_operational_marks')
      .insert({
        company_id: flag.company_id,
        flag_id: flagId,
        kind,
        marked_by: ctx.user.id,
      })

    if (insertErr) {
      console.error('[marks/toggle] insert error:', insertErr)
      redirect(`${detailUrl}?error=${encodeURIComponent(insertErr.message)}#operational`)
    }
  }

  redirect(`${detailUrl}?mark_toggled=1#operational`)
}
