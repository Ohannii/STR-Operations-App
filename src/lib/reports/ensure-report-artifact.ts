import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import {
  REPORT_ARTIFACTS_BUCKET,
  flagContentHash,
  flagReportObjectPath,
  packReportObjectPath,
} from '@/lib/reports/report-paths'
import { renderFlagReportPdf } from '@/lib/reports/flag-report-document'
import { renderPackReportPdf } from '@/lib/reports/pack-report-document'
import type { FlagReportData, PackReportData } from '@/lib/reports/report-data'
import {
  ensureAndSignArtifact,
  isReportConflict,
  type ArtifactStore,
} from '@/lib/reports/ensure-report-artifact-core'

/**
 * SERVER-ONLY adapter. Wires the pure create-only/reuse/collision core
 * (ensure-report-artifact-core.ts) to the service-role Supabase client and
 * owns the short-lived signed-download-URL responsibility. The `server-only`
 * guard stays here so service-role usage can never reach a client bundle.
 */

const DOWNLOAD_TTL_SECONDS = 90

function realStore(admin: ReturnType<typeof createServiceClient>): ArtifactStore {
  const bucket = admin.storage.from(REPORT_ARTIFACTS_BUCKET)
  return {
    async signExisting(path) {
      const { data } = await bucket.createSignedUrl(path, DOWNLOAD_TTL_SECONDS)
      return data?.signedUrl ?? null
    },
    async createOnly(path, bytes) {
      const { error } = await bucket.upload(path, bytes, {
        contentType: 'application/pdf',
        upsert: false,
      })
      if (!error) return { ok: true, conflict: false }
      return { ok: false, conflict: isReportConflict(error), error: error.message }
    },
  }
}

export async function ensureAndSignFlagReport(
  companyId: string,
  flagId: string,
  data: FlagReportData,
): Promise<string> {
  const admin = createServiceClient()
  const path = flagReportObjectPath(companyId, flagId, flagContentHash(data.fingerprint))
  return ensureAndSignArtifact(realStore(admin), path, () => renderFlagReportPdf(data))
}

export async function ensureAndSignPackReport(
  companyId: string,
  packId: string,
  data: PackReportData,
): Promise<string> {
  const admin = createServiceClient()
  const path = packReportObjectPath(companyId, packId)
  return ensureAndSignArtifact(realStore(admin), path, () => renderPackReportPdf(data))
}
