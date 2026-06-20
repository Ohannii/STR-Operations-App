import { notFound, redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /properties/[id]/pre-arrival/report
 *
 * Backward-compatible redirect. Earlier in Session 8 this route
 * rendered "every pre-arrival photo on this property ever" — that
 * model is gone (replaced by evidence_packs in migration 0013).
 *
 * Behaviour now:
 *   - If a draft pack exists → 302 to that pack's report.
 *   - Else if a submitted pack exists → 302 to the most recent
 *     submitted pack's report.
 *   - Else → 404.
 *
 * No UI lives here anymore. The per-pack page at
 * /properties/[id]/packs/[packId]/report is the source of truth.
 */
export default async function PreArrivalReportRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId } = await params
  const supabase = await createClient()

  // Look for a draft first (most useful for an in-flight turnover).
  const { data: draft } = await supabase
    .from('evidence_packs')
    .select('id')
    .eq('property_id', propertyId)
    .eq('pack_type', 'pre_arrival')
    .eq('status', 'draft')
    .is('deleted_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (draft) {
    redirect(`/properties/${propertyId}/packs/${draft.id}/report`)
  }

  const { data: submitted } = await supabase
    .from('evidence_packs')
    .select('id')
    .eq('property_id', propertyId)
    .eq('pack_type', 'pre_arrival')
    .eq('status', 'submitted')
    .is('deleted_at', null)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (submitted) {
    redirect(`/properties/${propertyId}/packs/${submitted.id}/report`)
  }

  notFound()
}
