import { NextResponse } from 'next/server'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { parseStatusIds } from '@/lib/issues/asana-status-poll'
import { loadFlagAsanaStatuses } from '@/lib/issues/load-pack-photo-issues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/issues/asana-status?ids=<flag uuid>,<flag uuid>
 *
 * READ-ONLY. The current Asana status of the caller's own company's issues
 * (saved task link + live create job), so the pack page can update a
 * "Sending to Asana" label in place without reloading. Uses the signed-in
 * user's RLS client; ids from another company simply come back as not
 * visible. Never cached.
 */
export async function GET(request: Request) {
  const ctx = await getUserContext()
  if (!ctx || !ctx.company) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ids = parseStatusIds(new URL(request.url).searchParams.get('ids'))
  if (!ids) return NextResponse.json({ error: 'invalid ids' }, { status: 400 })

  const supabase = await createClient()
  const lookup = await loadFlagAsanaStatuses(supabase, ctx.company.id, ids)
  const statuses: Record<string, string> = {}
  for (const [id, status] of lookup) {
    if (status !== 'deleted') statuses[id] = status
  }
  return NextResponse.json({ statuses }, { headers: { 'Cache-Control': 'no-store' } })
}
