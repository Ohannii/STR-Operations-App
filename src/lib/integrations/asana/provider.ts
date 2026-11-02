/**
 * Asana implementation of the provider-agnostic TaskProvider.
 *
 * `createAsanaProvider(token)` captures the token (passed in — never read
 * from env here). EVERY method asserts the pinned BETA project allowlist
 * BEFORE any network call.
 *
 * Stage 0 (idempotency): the task is created directly in its project AND
 * section in ONE request (atomic `memberships`); there is no follow-up
 * section call that could fail after the task already exists. getTask /
 * listTasksModifiedSince are READ-ONLY reconciliation lookups.
 */

import { assertAllowedProject } from '@/lib/integrations/asana/config'
import {
  createTaskInProject,
  getTaskForReconciliation,
  listProjectTasksModifiedSince,
} from '@/lib/integrations/asana/client'
import type { TaskPayload, TaskProvider } from '@/lib/integrations/types'

export function createAsanaProvider(token: string): TaskProvider {
  return {
    async createTask(payload: TaskPayload) {
      // HARD ALLOWLIST — runs before any fetch. A disallowed project
      // throws here and no network call is ever made.
      assertAllowedProject(payload.projectGid)

      const task = await createTaskInProject(token, {
        projectGid: payload.projectGid,
        sectionGid: payload.sectionGid,
        name: payload.name,
        notes: payload.notes,
        dueOn: payload.dueOn,
      })

      return { externalTaskGid: task.gid, externalTaskUrl: task.permalinkUrl }
    },

    async getTask(projectGid: string, taskGid: string) {
      assertAllowedProject(projectGid) // the task must be expected in BETA
      return getTaskForReconciliation(token, taskGid)
    },

    async listTasksModifiedSince(projectGid: string, modifiedSinceIso: string) {
      assertAllowedProject(projectGid)
      return listProjectTasksModifiedSince(token, projectGid, modifiedSinceIso)
    },
  }
}
