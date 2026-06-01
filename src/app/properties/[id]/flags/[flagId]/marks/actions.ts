'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { safeReturnTo } from '@/lib/safe-return-to'
import { createClient } from '@/lib/supabase/server'
import {
  ALL_CHIP_KINDS,
  chipMutexKinds,
  type ChipKind,
} from '@/lib/ui/chip-vocabulary'

/**
 * Server action invoked by the chip toggle buttons on the flag
 * detail page AND on the Action Centre's inline expanded card.
 *
 * Semantics:
 *   - If an active mark of this kind already exists on this flag,
 *     it gets cleared (cleared_at = now(), cleared_by = user).
 *     History row is preserved.
 *   - If no active mark exists, the action first clears every
 *     other active mark in the same CHIP_WORKFLOW_GROUPS entry —
 *     this is what enforces the "one active chip per workflow"
 *     rule, symmetrically. Setting asana_pending while asana_logged
 *     is active clears asana_logged, and vice versa. Setting any
 *     of the three maintenance chips clears the other two.
 *   - Then a new row is inserted for the chosen kind.
 *
 * RLS enforces company scope; the partial unique index on
 * (flag_id, kind) where cleared_at is null prevents duplicate
 * active marks of the same kind even under concurrent clicks.
 * Workflow-group mutex is application-level (postgres-side
 * enforcement would require a more elaborate constraint and is
 * deliberately out of scope for v1.0).
 */
export async function toggleFlagMarkAction(formData: FormData) {
  const propertyId = String(formData.get('property_id') ?? '').trim()
  const flagId = String(formData.get('flag_id') ?? '').trim()
  const kindRaw = String(formData.get('kind') ?? '').trim()

  const detailUrl = `/properties/${propertyId}/flags/${flagId}`

  if (!propertyId || !flagId) {
    redirect(`/dashboard?error=${encodeURIComponent('Missing flag reference.')}`)
  }

  // Session 7: optional return_to lets the Action Centre redirect back
  // to itself with the same `?open=` expansion state after a chip
  // toggle. safeReturnTo enforces an internal path scoped to
  // /properties/{propertyId} -- this rejects protocol-relative URLs
  // (//evil.com), absolute schemes (http://, https://), backslash
  // tricks, and any path outside the current property.
  const returnTo = safeReturnTo(formData.get('return_to'), propertyId)
  if (!ALL_CHIP_KINDS.includes(kindRaw as ChipKind)) {
    if (returnTo) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent('Unknown chip kind.')}`)
    }
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
    if (returnTo) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(flagErr.message)}`)
    }
    redirect(`${detailUrl}?error=${encodeURIComponent(flagErr.message)}#operational`)
  }
  if (!flag) {
    if (returnTo) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent('Flag not found.')}`)
    }
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
    if (returnTo) {
      redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(readErr.message)}`)
    }
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
      if (returnTo) {
        redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(clearErr.message)}`)
      }
      redirect(`${detailUrl}?error=${encodeURIComponent(clearErr.message)}#operational`)
    }
  } else {
    // Toggle ON: first clear any other active chips in the SAME
    // workflow group (mutex semantics — symmetric in both directions:
    // asana_pending → asana_logged and asana_logged → asana_pending
    // both leave a single active chip). Then insert the new mark.
    const mutexKinds = chipMutexKinds(kind)
    if (mutexKinds.length > 0) {
      const { error: mutexErr } = await supabase
        .from('flag_operational_marks')
        .update({
          cleared_at: now,
          cleared_by: ctx.user.id,
        })
        .eq('flag_id', flagId)
        .in('kind', mutexKinds)
        .is('cleared_at', null)
      if (mutexErr) {
        // Mutex clearing failure is non-fatal — we can still record
        // the new mark. Log it and continue. The partial unique
        // index protects against duplicate active rows of the same
        // kind; if a sibling stayed active in the same group, the
        // worst case is two active workflow chips, which the user
        // can correct with another click.
        console.error('[marks/toggle] mutex clear error:', mutexErr)
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
      if (returnTo) {
        redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(insertErr.message)}`)
      }
      redirect(`${detailUrl}?error=${encodeURIComponent(insertErr.message)}#operational`)
    }
  }

  // Session 8 fix: explicit revalidation so Action Centre chip
  // displays reflect the toggle without needing a hard reload.
  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/flags/${flagId}`)

  // Session 7: return_to (when present and safe) wins over the
  // default detail-page redirect. The Action Centre supplies a
  // return URL that preserves the `?open=` expansion state so the
  // user lands back at the same flag, still expanded, with the new
  // chip state visible.
  if (returnTo) {
    redirect(returnTo)
  }
  redirect(`${detailUrl}?mark_toggled=1#operational`)
}
