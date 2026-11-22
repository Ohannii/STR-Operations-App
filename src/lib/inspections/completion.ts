import { validId, type TurnoverJob } from './workboard'

export type CompletedInspection = TurnoverJob & { pack_id: string; submitted_at: string }
export type InspectionCompletion = {
  property_id: string; pack_id: string; submitted_at: string; submitter_name: string | null; due_on?: string
}
export type SubmittedInspectionPack = {
  id: string; property_id: string; status: string; deleted_at: string | null; submitted_at: string | null; submitted_by: string | null
}

/** URL intent selects a visit; only a matching server-confirmed row proves completion. */
export function completedInspectionForPack(jobs: TurnoverJob[], propertyId: string, packId: unknown): CompletedInspection | null {
  if (!validId(packId)) return null
  return jobs.find((job): job is CompletedInspection => job.property_id === propertyId && job.pack_id === packId
    && !job.cancelled_at && !job.pack_deleted && job.pack_status === 'submitted'
    && typeof job.submitted_at === 'string' && Number.isFinite(Date.parse(job.submitted_at))) ?? null
}

/** A standalone submitted pack records an inspection too, but never completes an unrelated visit. */
export function inspectionCompletionForPack(jobs: TurnoverJob[] | null, propertyId: string, packId: unknown,
  pack: SubmittedInspectionPack | undefined, submitterName: string | null): InspectionCompletion | null {
  if (!jobs || !validId(packId)) return null
  // A known linked visit must pass its own state checks; do not mask a
  // cancellation/deletion by falling back to the pack's submitted state.
  if (jobs.some(job => job.property_id === propertyId && job.pack_id === packId)) return completedInspectionForPack(jobs, propertyId, packId)
  if (!pack || pack.id !== packId || pack.property_id !== propertyId || pack.status !== 'submitted'
    || pack.deleted_at !== null || !pack.submitted_at || !Number.isFinite(Date.parse(pack.submitted_at))) return null
  return { property_id: propertyId, pack_id: packId, submitted_at: pack.submitted_at, submitter_name: submitterName }
}
