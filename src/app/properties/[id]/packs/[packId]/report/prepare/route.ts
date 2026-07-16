import { NextResponse } from 'next/server'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { loadPackReportData } from '@/lib/reports/report-data'
import { ensureAndSignPackReport } from '@/lib/reports/ensure-report-artifact'
import { packShareFilename } from '@/lib/reports/report-paths'
import { formatDateSAST } from '@/lib/ui/datetime'

export const runtime = 'nodejs'

/**
 * POST /properties/[id]/packs/[packId]/report/prepare
 *
 * Same authorize-then-generate flow as the flag route. Packs are immutable
 * once submitted, so ONLY submitted packs get a canonical PDF (drafts are
 * still editable and have no stable artifact).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; packId: string }> },
) {
  const { id: propertyId, packId } = await params

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const supabase = await createClient()
  const { data: pack, error } = await supabase
    .from('evidence_packs')
    .select('id, company_id, property_id, status')
    .eq('id', packId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string; property_id: string; status: string }>()
  if (error) {
    console.error('[reports/pack/prepare] authz read error:', error.message)
    return NextResponse.json({ error: 'Could not prepare the PDF.' }, { status: 500 })
  }
  if (!pack || pack.company_id !== ctx.company.id) {
    return NextResponse.json({ error: 'Pack not found.' }, { status: 404 })
  }
  if (pack.status !== 'submitted') {
    return NextResponse.json(
      { error: 'Only submitted packs can be shared as PDF.' },
      { status: 409 },
    )
  }

  try {
    const data = await loadPackReportData(ctx.company.name, packId)
    if (!data) {
      return NextResponse.json({ error: 'Pack not found.' }, { status: 404 })
    }
    const url = await ensureAndSignPackReport(ctx.company.id, packId, data)
    const filename = packShareFilename(
      data.title,
      data.propertyName,
      formatDateSAST(new Date().toISOString()),
    )
    return NextResponse.json({ url, filename })
  } catch (err) {
    console.error('[reports/pack/prepare] generation error:', err)
    return NextResponse.json({ error: 'Could not prepare the PDF.' }, { status: 500 })
  }
}
