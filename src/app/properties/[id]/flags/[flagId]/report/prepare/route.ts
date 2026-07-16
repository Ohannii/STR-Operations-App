import { NextResponse } from 'next/server'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { loadFlagReportData } from '@/lib/reports/report-data'
import { ensureAndSignFlagReport } from '@/lib/reports/ensure-report-artifact'
import { flagShareFilename } from '@/lib/reports/report-paths'
import { formatDateDMY } from '@/lib/ui/datetime'

// Node runtime — @react-pdf/renderer + Storage download/upload.
export const runtime = 'nodejs'

/**
 * POST /properties/[id]/flags/[flagId]/report/prepare
 *
 * 1. Authorizes the caller against the flag via their RLS-scoped session.
 * 2. Only THEN uses trusted server code (service role) to generate/ensure
 *    the immutable PDF artifact and mint a short-lived signed download URL.
 * Returns { url, filename } — never proxies PDF bytes (Vercel 4.5 MB limit),
 * never logs the signed URL, never exposes service-role credentials.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; flagId: string }> },
) {
  const { id: propertyId, flagId } = await params

  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // Authorization: RLS scopes this read to the caller's company.
  const supabase = await createClient()
  const { data: flag, error } = await supabase
    .from('flags')
    .select('id, company_id, property_id')
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; company_id: string; property_id: string }>()
  if (error) {
    console.error('[reports/flag/prepare] authz read error:', error.message)
    return NextResponse.json({ error: 'Could not prepare the PDF.' }, { status: 500 })
  }
  if (!flag || flag.company_id !== ctx.company.id) {
    return NextResponse.json({ error: 'Flag not found.' }, { status: 404 })
  }

  try {
    const data = await loadFlagReportData(ctx.company.name, flagId)
    if (!data) {
      return NextResponse.json({ error: 'Flag not found.' }, { status: 404 })
    }
    const url = await ensureAndSignFlagReport(ctx.company.id, flagId, data)
    const filename = flagShareFilename(
      data.propertyName,
      data.issueTitle,
      formatDateDMY(data.raisedAtIso),
    )
    return NextResponse.json({ url, filename })
  } catch (err) {
    console.error('[reports/flag/prepare] generation error:', err)
    return NextResponse.json({ error: 'Could not prepare the PDF.' }, { status: 500 })
  }
}
