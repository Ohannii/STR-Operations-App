/**
 * Shared contracts for outbound integrations (provider-agnostic).
 *
 * Slice 3: types only — no implementations, no I/O, no wiring. These
 * exist so later slices (provider client, worker) build against a
 * stable shape, and so the mapping layer has a typed output.
 *
 * The app remains the source of truth; these describe how an app
 * entity is projected OUT to an external task system, never the
 * reverse.
 */

/** Outbound task systems. Phase 1 ships only 'asana'. */
export type IntegrationProvider = 'asana'

/**
 * Outbox event kinds.
 *   - asana.create_task_for_flag  (Slice 4/8): create the Asana task.
 *   - asana.attach_flag_evidence  (Slice 11C2): attach the flag PDF +
 *     each compressed master photo to the existing task.
 */
export type OutboxEventType =
  | 'asana.create_task_for_flag'
  | 'asana.attach_flag_evidence'

/** Internal entity kinds that can be projected outward. Phase 1: flag. */
export type IntegrationEntityType = 'flag'

/**
 * The fully-resolved shape a provider needs to create a task. In
 * Phase 1 `projectGid` is always the pinned BETA test project (see
 * asana/config.ts); the provider re-asserts that before any write.
 */
export interface TaskPayload {
  workspaceGid: string
  projectGid: string
  sectionGid: string
  name: string
  notes: string
  /** YYYY-MM-DD. Set only for same-day (safety) items. */
  dueOn?: string
  /**
   * BETA custom-field values keyed by field GID, produced ONLY by
   * resolveCustomFields from a writable BETA validation. Absent or empty =
   * no `custom_fields` in the request. The provider refuses any GID that is
   * not a configured BETA field before any network call.
   */
  customFields?: Record<string, string | string[]>
}

/** A task as seen by READ-ONLY reconciliation: identity, notes, projects. */
export interface ProviderTask {
  gid: string
  notes: string | null
  projectGids: string[]
}

/**
 * Provider interface. Every method asserts the pinned project allowlist
 * BEFORE any network call. Only createTask writes; the other two are
 * read-only lookups used to reconcile an ambiguous create (Stage 0).
 */
export interface TaskProvider {
  createTask(
    payload: TaskPayload,
  ): Promise<{ externalTaskGid: string; externalTaskUrl: string }>
  /** READ-ONLY. null = the task does not exist / is not visible (404). */
  getTask(projectGid: string, taskGid: string): Promise<ProviderTask | null>
  /** READ-ONLY. Every task of the project modified since the given time. */
  listTasksModifiedSince(projectGid: string, modifiedSinceIso: string): Promise<ProviderTask[]>
}
