import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { isValidTriggerSecret } from '@/lib/integrations/worker/auth'
import { createServiceClient } from '@/lib/supabase/service'
import {
  dryRunNextAsanaOutbox,
  runNextAsanaOutbox,
} from '@/lib/integrations/worker/process-outbox'
import { createAsanaProvider } from '@/lib/integrations/asana/provider'
import { parseAllowedCompanyIds } from '@/lib/integrations/company-allowlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual Asana worker (Slices 7 + 8).
 *
 * POST only, protected by a trigger secret. Processes ONE pending
 * outbox row. `ASANA_WORKER_DRY_RUN=false` performs the real run
 * (create one Asana task + write-backs); anything else is a dry run
 * (builds/returns the payload, no Asana call, no writes).
 */
export async function POST() {
  const hdrs = await headers()

  // 1. Auth — constant-time trigger-secret check. Fails closed.
  if (!isValidTriggerSecret(hdrs.get('x-worker-secret'), process.env.ASANA_WORKER_TRIGGER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2. Config. No ASANA_ACCESS_TOKEN is read unless we take the real-run branch.
  const allowedCompanyIds = parseAllowedCompanyIds(process.env.ASANA_ALLOWED_COMPANY_IDS)
  const host = hdrs.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const appBaseUrl = process.env.APP_BASE_URL ?? `${protocol}://${host}`
  const todayIso = new Date().toISOString().slice(0, 10)
  const deps = { allowedCompanyIds, appBaseUrl, todayIso }

  const supabase = createServiceClient()

  // 3. Real run only when explicitly enabled.
  if (process.env.ASANA_WORKER_DRY_RUN === 'false') {
    const token = process.env.ASANA_ACCESS_TOKEN
    if (!token) {
      return NextResponse.json({ error: 'ASANA_ACCESS_TOKEN not configured' }, { status: 500 })
    }
    const provider = createAsanaProvider(token)
    const result = await runNextAsanaOutbox(supabase, provider, deps)
    console.log('[asana-worker][real-run]', JSON.stringify(result))
    return NextResponse.json({ dryRun: false, ...result })
  }

  // 4. Default: dry run. No token read, no Asana call, no writes.
  const result = await dryRunNextAsanaOutbox(supabase, deps)
  console.log('[asana-worker][dry-run]', JSON.stringify(result))
  return NextResponse.json({ dryRun: true, ...result })
}
