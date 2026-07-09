/**
 * Asana implementation of the provider-agnostic TaskProvider (Slice 6).
 *
 * `createAsanaProvider(token)` captures the token (passed in — never
 * read from env here) and returns a TaskProvider. Before ANY network
 * call, `createTask` asserts the target project is the pinned BETA
 * project (the hard project allowlist). No real call is made in this
 * slice; nothing wires this in yet.
 */

import { assertAllowedProject } from '@/lib/integrations/asana/config'
import {
  addTaskToSection,
  createTaskInProject,
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
        name: payload.name,
        notes: payload.notes,
        dueOn: payload.dueOn,
      })

      await addTaskToSection(token, {
        taskGid: task.gid,
        sectionGid: payload.sectionGid,
      })

      return { externalTaskGid: task.gid, externalTaskUrl: task.permalinkUrl }
    },
  }
}
