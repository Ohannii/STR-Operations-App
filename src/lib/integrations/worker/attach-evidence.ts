import 'server-only'
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readAndGuardOutbox, type DryRunDeps } from '@/lib/integrations/worker/process-outbox'
import {
  runAttachEvidence,
  type AttachIO,
  type AttachResult,
  type EvidenceBundle,
} from '@/lib/integrations/worker/attach-evidence-core'
import { listTaskAttachments, addAttachmentToTask } from '@/lib/integrations/asana/client'
import { loadFlagReportData } from '@/lib/reports/report-data'
import { ensureFlagReportBytes } from '@/lib/reports/ensure-report-artifact'
import { formatDateDMY } from '@/lib/ui/datetime'
import { EVIDENCE_BUCKET } from '@/lib/photos/paths'

const MAX_ATTEMPTS = 8
const RETRY_BACKOFF_MINUTES = 5

/**
 * SERVER-ONLY: wire the pure attach orchestration to Supabase (outbox +
 * storage), the Asana client, and the report generator. Every read is
 * tenant-scoped by company_id + flag_id; storage paths are never trusted
 * beyond the verified company/flag prefix. The Asana token is passed in
 * and never logged.
 */
export function createAttachIO(supabase: SupabaseClient, token: string): AttachIO {
  const outbox = () => supabase.from('integration_outbox')

  return {
    newRunId: () => randomUUID(),

    async claim(outboxId, runId) {
      const { data } = await outbox()
        .update({ status: 'processing', locked_at: new Date().toISOString(), locked_by: runId })
        .eq('id', outboxId)
        .eq('status', 'pending')
        .select('payload')
        .maybeSingle<{ payload: Record<string, unknown> | null }>()
      if (!data) return null
      return { generation: Number(data.payload?.content_generation ?? 1) }
    },

    async heartbeat(outboxId, runId) {
      await outbox()
        .update({ locked_at: new Date().toISOString() })
        .eq('id', outboxId)
        .eq('locked_by', runId)
    },

    async completeIfGen(outboxId, runId, generation) {
      const { data } = await outbox()
        .update({ status: 'done', processed_at: new Date().toISOString(), locked_at: null })
        .eq('id', outboxId)
        .eq('locked_by', runId)
        .filter('payload->>content_generation', 'eq', String(generation))
        .select('id')
      return Array.isArray(data) && data.length > 0
    },

    async reschedule(outboxId, runId, opts) {
      const patch: Record<string, unknown> = {
        status: 'pending',
        available_at: new Date(Date.now() + opts.availableInSeconds * 1000).toISOString(),
        locked_at: null,
      }
      if (opts.setDepWaitStartedAt) {
        const { data } = await outbox()
          .select('payload')
          .eq('id', outboxId)
          .maybeSingle<{ payload: Record<string, unknown> | null }>()
        patch.payload = {
          ...(data?.payload ?? {}),
          dep_wait_started_at: new Date().toISOString(),
        }
      }
      await outbox().update(patch).eq('id', outboxId).eq('locked_by', runId)
    },

    async failRetry(outboxId, attemptCount, message) {
      const attempts = attemptCount + 1
      const dead = attempts >= MAX_ATTEMPTS
      const patch: Record<string, unknown> = {
        status: dead ? 'dead' : 'pending',
        attempt_count: attempts,
        last_error: message.slice(0, 500),
        locked_at: null,
      }
      if (!dead) {
        patch.available_at = new Date(Date.now() + RETRY_BACKOFF_MINUTES * 60_000).toISOString()
      }
      await outbox().update(patch).eq('id', outboxId)
    },

    async deadLetter(outboxId, reason) {
      await outbox()
        .update({ status: 'dead', last_error: reason.slice(0, 500), locked_at: null })
        .eq('id', outboxId)
    },

    async getDepWaitStartedAt(outboxId) {
      const { data } = await outbox()
        .select('payload')
        .eq('id', outboxId)
        .maybeSingle<{ payload: Record<string, unknown> | null }>()
      const v = data?.payload?.dep_wait_started_at
      return typeof v === 'string' ? v : null
    },

    async resolveTaskGid(companyId, flagId) {
      const { data } = await supabase
        .from('external_task_links')
        .select('external_task_gid')
        .eq('company_id', companyId)
        .eq('provider', 'asana')
        .eq('internal_entity_type', 'flag')
        .eq('internal_entity_id', flagId)
        .is('deleted_at', null)
        .maybeSingle<{ external_task_gid: string }>()
      return data?.external_task_gid ?? null
    },

    async loadEvidence(companyId, flagId): Promise<EvidenceBundle | null> {
      // Tenant boundary: the flag MUST belong to this company.
      const { data: flagRow } = await supabase
        .from('flags')
        .select('company_id')
        .eq('id', flagId)
        .is('deleted_at', null)
        .maybeSingle<{ company_id: string }>()
      if (!flagRow || flagRow.company_id !== companyId) return null

      const { data: co } = await supabase
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .maybeSingle<{ name: string }>()

      const data = await loadFlagReportData(co?.name ?? 'Company', flagId)
      if (!data) return null

      const { bytes, contentHash } = await ensureFlagReportBytes(companyId, flagId, data)

      // Never trust a storage path outside this company/flag prefix.
      const prefix = `companies/${companyId}/flags/${flagId}/`
      const photos = data.fingerprint.photos
        .filter((p) => p.storagePath.startsWith(prefix))
        .map((p, i) => ({ photoId: p.id, ordinal: i + 1, masterPath: p.storagePath }))

      return {
        unit: data.propertyName,
        flagTitle: data.issueTitle?.trim() || 'Flag',
        raisedDMY: formatDateDMY(data.raisedAtIso),
        contentHash,
        pdfBytes: bytes,
        photos,
      }
    },

    async downloadMaster(path) {
      const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).download(path)
      if (error || !data) {
        console.error('[attach] master unavailable for a photo (skipped)')
        return null
      }
      return new Uint8Array(await data.arrayBuffer())
    },

    async listAttachmentNames(taskGid) {
      const list = await listTaskAttachments(token, taskGid)
      return list.map((a) => a.name)
    },

    async uploadAttachment(taskGid, filename, contentType, bytes) {
      await addAttachmentToTask(token, { taskGid, filename, contentType, bytes })
    },
  }
}

/**
 * Process AT MOST ONE pending attach-evidence event (company-allowlisted).
 * Returns 'no_pending' when the attach queue is empty.
 */
export async function runNextAttachEvidence(
  supabase: SupabaseClient,
  deps: DryRunDeps,
  token: string,
): Promise<AttachResult | { status: 'no_pending' }> {
  const g = await readAndGuardOutbox(supabase, deps, 'asana.attach_flag_evidence')
  if (g.kind === 'no_pending') return { status: 'no_pending' }
  if (g.kind === 'refused') {
    await supabase
      .from('integration_outbox')
      .update({ status: 'dead', last_error: g.reason, locked_at: null })
      .eq('id', g.outboxId)
    return { status: 'refused', outboxId: g.outboxId, reason: g.reason }
  }
  const io = createAttachIO(supabase, token)
  return runAttachEvidence(io, {
    outboxId: g.outboxId,
    companyId: g.companyId,
    flagId: g.flagId,
    attemptCount: g.attemptCount,
  })
}
