import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { isValidTriggerSecret } from '@/lib/integrations/worker/auth'
import { createServiceClient } from '@/lib/supabase/service'
import {
  dryRunNextAsanaOutbox,
  runNextAsanaOutbox,
  runAsanaOutboxBatch,
} from '@/lib/integrations/worker/process-outbox'
import { createAsanaProvider } from '@/lib/integrations/asana/provider'
import { parseAllowedCompanyIds } from '@/lib/integrations/company-allowlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function workerDeps(host: string) {
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  return {
    allowedCompanyIds: parseAllowedCompanyIds(process.env.ASANA_ALLOWED_COMPANY_IDS),
    appBaseUrl: process.env.APP_BASE_URL ?? `${protocol}://${host}`,
    todayIso: new Date().toISOString().slice(0, 10),
  }
}

/**
 * GET — automatic Vercel Cron trigger (Slice 10). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`; we verify it (constant-time).
 * Processes a small batch, and ONLY does real writes when
 * ASANA_WORKER_DRY_RUN === 'false'. No Asana token is read otherwise.
 */
export async function GET(request: Request) {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!isValidTriggerSecret(token, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (process.env.ASANA_WORKER_DRY_RUN !== 'false') {
    return NextResponse.json({ ran: false, reason: 'ASANA_WORKER_DRY_RUN is not false' })
  }
  const asanaToken = process.env.ASANA_ACCESS_TOKEN
  if (!asanaToken) {
    return NextResponse.json({ error: 'ASANA_ACCESS_TOKEN not configured' }, { status: 500 })
  }

  const host = request.headers.get('host') ?? 'localhost:3000'
  const deps = workerDeps(host)
  const batch = Number(process.env.ASANA_WORKER_BATCH ?? '1') || 1
  const supabase = createServiceClient()
  const provider = createAsanaProvider(asanaToken)

  const results = await runAsanaOutboxBatch(supabase, provider, deps, batch)
  console.log('[asana-worker][cron]', JSON.stringify({ processed: results.length, results }))
  return NextResponse.json({ ran: true, processed: results.length, results })
}

/**
 * POST — manual / emergency trigger. Protected by the separate
 * ASANA_WORKER_TRIGGER_SECRET. Processes ONE row (dry-run unless
 * ASANA_WORKER_DRY_RUN === 'false').
 */
export async function POST() {
  const hdrs = await headers()
  if (!isValidTriggerSecret(hdrs.get('x-worker-secret'), process.env.ASANA_WORKER_TRIGGER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const host = hdrs.get('host') ?? 'localhost:3000'
  const deps = workerDeps(host)
  const supabase = createServiceClient()

  if (process.env.ASANA_WORKER_DRY_RUN === 'false') {
    const asanaToken = process.env.ASANA_ACCESS_TOKEN
    if (!asanaToken) {
      return NextResponse.json({ error: 'ASANA_ACCESS_TOKEN not configured' }, { status: 500 })
    }
    const provider = createAsanaProvider(asanaToken)
    const result = await runNextAsanaOutbox(supabase, provider, deps)
    console.log('[asana-worker][manual]', JSON.stringify(result))
    return NextResponse.json({ dryRun: false, ...result })
  }

  const result = await dryRunNextAsanaOutbox(supabase, deps)
  console.log('[asana-worker][dry-run]', JSON.stringify(result))
  return NextResponse.json({ dryRun: true, ...result })
}
