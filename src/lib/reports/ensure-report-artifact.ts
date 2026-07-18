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
  ensureArtifactBytes,
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
    async download(path) {
      const { data, error } = await bucket.download(path)
      if (error || !data) return null
      return Buffer.from(await data.arrayBuffer())
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

/**
 * Server-only: ensure the flag report PDF exists (create-only, reusing the
 * PR #49 artifact) and return its bytes + content hash. Used by the Asana
 * attach worker to upload the canonical PDF.
 */
export async function ensureFlagReportBytes(
  companyId: string,
  flagId: string,
  data: FlagReportData,
): Promise<{ bytes: Buffer; contentHash: string }> {
  const admin = createServiceClient()
  const contentHash = flagContentHash(data.fingerprint)
  const path = flagReportObjectPath(companyId, flagId, contentHash)
  const bytes = await ensureArtifactBytes(realStore(admin), path, () =>
    renderFlagReportPdf(data),
  )
  return { bytes, contentHash }
}
