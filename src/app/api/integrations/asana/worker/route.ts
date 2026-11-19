import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { isValidTriggerSecret } from '@/lib/integrations/worker/auth'
import { createServiceClient } from '@/lib/supabase/service'
import {
  dryRunNextAsanaOutbox,
  runNextAsanaOutbox,
  runAsanaOutboxBatch,
} from '@/lib/integrations/worker/process-outbox'
import { runNextAttachEvidence } from '@/lib/integrations/worker/attach-evidence'
import { createAsanaProvider } from '@/lib/integrations/asana/provider'
import { parseAllowedCompanyIds } from '@/lib/integrations/company-allowlist'
import { ASANA_TEST_PROJECT_GID, liveIncidentsTestEnabled } from '@/lib/integrations/asana/config'
import { ASANA_DESTINATIONS } from '@/lib/integrations/asana/destinations'
import { configForWrite } from '@/lib/integrations/asana/field-config'
import { createWritableFieldValidationLoader } from '@/lib/integrations/asana/field-schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function workerDeps(host: string) {
  const protocol = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  return {
    allowedCompanyIds: parseAllowedCompanyIds(process.env.ASANA_ALLOWED_COMPANY_IDS),
    appBaseUrl: process.env.APP_BASE_URL ?? `${protocol}://${host}`,
    todayIso: new Date().toISOString().slice(0, 10),
  }
}

/**
 * ONE lazy, memoised BETA field-schema loader for THIS request (real runs
 * only). configForWrite asserts the BETA allowlist; the worker calls the
 * loader only when it is about to create a new task.
 */
function fieldValidationLoader(asanaToken: string) {
  return createWritableFieldValidationLoader(asanaToken, configForWrite(ASANA_TEST_PROJECT_GID))
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
  const deps = { ...workerDeps(host), loadFieldValidation: fieldValidationLoader(asanaToken) }
  const batch = Number(process.env.ASANA_WORKER_BATCH ?? '1') || 1
  const supabase = createServiceClient()
  const provider = createAsanaProvider(asanaToken)

  // Create-task pass (drains up to `batch`), then AT MOST ONE attach pass so
  // a single tick can never fan out into dozens of large uploads.
  const results = await runAsanaOutboxBatch(supabase, provider, deps, batch)
  const attach = await runNextAttachEvidence(supabase, deps, asanaToken)
  console.log(
    '[asana-worker][cron]',
    JSON.stringify({ created: results.length, results, attach }),
  )
  return NextResponse.json({ ran: true, processed: results.length, results, attach })
}

/**
 * POST — manual / emergency trigger. Protected by the separate
 * ASANA_WORKER_TRIGGER_SECRET. Processes ONE row (dry-run unless
 * ASANA_WORKER_DRY_RUN === 'false').
 *
 * Default (no query): the BETA queue, exactly as before.
 *
 * CONTROLLED LIVE TEST: `?target=live_incidents&flag=<flag uuid>` processes
 * ONLY that flag's live-destination job (create, then at most one attach).
 *   - refused (409, nothing read or written) unless the live test switch
 *     ASANA_LIVE_INCIDENTS_TEST === 'true' on THIS deployment;
 *   - `flag` is mandatory, so a run can never pick up some other job;
 *   - `&dryRun=1` forces a dry run: it returns the exact task that WOULD be
 *     created (project, section, name, custom fields) and creates nothing.
 * The scheduled GET above never reads the live queue.
 */
export async function POST(request: Request) {
  const hdrs = await headers()
  if (!isValidTriggerSecret(hdrs.get('x-worker-secret'), process.env.ASANA_WORKER_TRIGGER_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const host = hdrs.get('host') ?? 'localhost:3000'
  const params = new URL(request.url).searchParams
  const target = params.get('target')
  if (target !== null && target !== 'live_incidents') {
    return NextResponse.json({ error: 'unknown target' }, { status: 400 })
  }

  if (target === 'live_incidents') {
    if (!liveIncidentsTestEnabled()) {
      return NextResponse.json({ error: 'live test is switched off on this deployment' }, { status: 409 })
    }
    const flagId = params.get('flag') ?? ''
    if (!UUID_RE.test(flagId)) {
      return NextResponse.json({ error: 'a valid flag id is required for the live test' }, { status: 400 })
    }
    const asanaToken = process.env.ASANA_ACCESS_TOKEN
    if (!asanaToken) {
      return NextResponse.json({ error: 'ASANA_ACCESS_TOKEN not configured' }, { status: 500 })
    }
    const deps = {
      ...workerDeps(host),
      destination: 'live_incidents' as const,
      onlyFlagId: flagId,
      // Read-only schema load for the LIVE project (configForWrite refuses
      // it unless the live test switch is on).
      loadFieldValidation: createWritableFieldValidationLoader(
        asanaToken,
        configForWrite(ASANA_DESTINATIONS.live_incidents.projectGid),
      ),
    }
    const supabase = createServiceClient()
    const forcedDryRun = params.get('dryRun') === '1'
    if (forcedDryRun || process.env.ASANA_WORKER_DRY_RUN !== 'false') {
      const result = await dryRunNextAsanaOutbox(supabase, deps)
      console.log('[asana-worker][live-test][dry-run]', JSON.stringify({ flagId, status: result.status }))
      return NextResponse.json({ dryRun: true, target, ...result })
    }
    const provider = createAsanaProvider(asanaToken, 'live_incidents')
    const result = await runNextAsanaOutbox(supabase, provider, deps)
    const attach = await runNextAttachEvidence(supabase, deps, asanaToken)
    console.log('[asana-worker][live-test]', JSON.stringify({ result, attach }))
    return NextResponse.json({ dryRun: false, target, ...result, attach })
  }

  const deps = workerDeps(host)
  const supabase = createServiceClient()

  if (process.env.ASANA_WORKER_DRY_RUN === 'false') {
    const asanaToken = process.env.ASANA_ACCESS_TOKEN
    if (!asanaToken) {
      return NextResponse.json({ error: 'ASANA_ACCESS_TOKEN not configured' }, { status: 500 })
    }
    const provider = createAsanaProvider(asanaToken)
    const result = await runNextAsanaOutbox(supabase, provider, {
      ...deps,
      loadFieldValidation: fieldValidationLoader(asanaToken),
    })
    console.log('[asana-worker][manual]', JSON.stringify(result))
    return NextResponse.json({ dryRun: false, ...result })
  }

  const result = await dryRunNextAsanaOutbox(supabase, deps)
  console.log('[asana-worker][dry-run]', JSON.stringify(result))
  return NextResponse.json({ dryRun: true, ...result })
}
