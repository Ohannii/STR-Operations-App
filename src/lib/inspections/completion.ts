import { validId, type TurnoverJob } from './workboard'

export type CompletedInspection = TurnoverJob & { pack_id: string; submitted_at: string }

/** URL intent selects a visit; only a matching server-confirmed row proves completion. */
export function completedInspectionForPack(jobs: TurnoverJob[], propertyId: string, packId: unknown): CompletedInspection | null {
  if (!validId(packId)) return null
  return jobs.find((job): job is CompletedInspection => job.property_id === propertyId && job.pack_id === packId
    && !job.cancelled_at && !job.pack_deleted && job.pack_status === 'submitted'
    && typeof job.submitted_at === 'string' && Number.isFinite(Date.parse(job.submitted_at))) ?? null
}
