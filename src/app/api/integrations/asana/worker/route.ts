import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { isValidTriggerSecret } from '@/lib/integrations/worker/auth'
import { createServiceClient } from '@/lib/supabase/service'
import { dryRunNextAsanaOutbox } from '@/lib/integrations/worker/process-outbox'
import { parseAllowedCompanyIds } from '@/lib/integrations/company-allowlist'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual DRY-RUN Asana worker (Slice 7).
 *
 * POST only, protected by a trigger secret. Reads one pending outbox
 * row and returns the task payload it WOULD send — no Asana call, no DB
 * writes, no Asana token read. Real-run is deliberately not implemented
 * here and is refused even if the env asks for it.
 */
export async function POST() {
  const hdrs = await headers()

  // 1. Auth — constant-time trigger-secret check. Fails closed.
  if (!isValidTriggerSecret(hdrs.get('x-worker-secret'), process.env.ASANA_WORKER_TRIGGER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2. Dry-run only in this slice — refuse a real run outright.
  if (process.env.ASANA_WORKER_DRY_RUN === 'false') {
    return NextResponse.json(
      { error: 'real-run not implemented in this slice' },
      { status: 501 },
    )
  }

  // 3. Resolve config. No ASANA_ACCESS_TOKEN is read anywhere here.
  const allowedCompanyIds = parseAllowedCompanyIds(process.env.ASANA_ALLOWED_COMPANY_IDS)
  const host = hdrs.get('host') ?? 'localhost:3000'
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const appBaseUrl = process.env.APP_BASE_URL ?? `${protocol}://${host}`
  const todayIso = new Date().toISOString().slice(0, 10)

  // 4. Service-role client (server-only) for narrowly-scoped reads.
  const supabase = createServiceClient()

  const result = await dryRunNextAsanaOutbox(supabase, {
    allowedCompanyIds,
    appBaseUrl,
    todayIso,
  })

  // Log what we WOULD send (no token is present in the payload).
  console.log('[asana-worker][dry-run]', JSON.stringify(result))

  return NextResponse.json({ dryRun: true, ...result })
}
