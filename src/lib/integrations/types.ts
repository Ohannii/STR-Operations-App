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
}

/**
 * Provider interface. DEFINED here in Slice 3 but intentionally NOT
 * implemented — there is no HTTP client and no Asana call yet.
 */
export interface TaskProvider {
  createTask(
    payload: TaskPayload,
  ): Promise<{ externalTaskGid: string; externalTaskUrl: string }>
}
