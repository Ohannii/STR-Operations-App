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
  hasCustomFields,
  listProjectTasksModifiedSince,
} from '@/lib/integrations/asana/client'
import { configForWrite } from '@/lib/integrations/asana/field-config'
import type { TaskPayload, TaskProvider } from '@/lib/integrations/types'

/** Thrown (before any network call) for a custom field outside the BETA config. */
export class DisallowedAsanaFieldError extends Error {
  constructor(reason: string) {
    super(`Refusing to send custom fields: ${reason}`)
    this.name = 'DisallowedAsanaFieldError'
  }
}

/**
 * BETA FIELD BOUNDARY. Every key must be a field GID of the WRITABLE
 * configuration for this project (configForWrite asserts the project
 * allowlist, so the live reference can never be used), and every value must
 * have that field's shape: enum -> one configured option GID; multi_enum ->
 * an array of configured option GIDs (any non-empty GIDs for a
 * dynamic-option field); text -> a string. GIDs only, never names.
 */
export function assertBetaCustomFields(
  projectGid: string,
  fields: Record<string, string | string[]>,
): void {
  const config = configForWrite(projectGid)
  const byGid = new Map(Object.values(config.fields).map((spec) => [spec!.gid, spec!]))
  for (const [fieldGid, value] of Object.entries(fields)) {
    const spec = byGid.get(fieldGid)
    if (!spec) throw new DisallowedAsanaFieldError(`field ${fieldGid} is not a configured BETA field`)
    const optionGids = new Set(Object.values(spec.options ?? {}))
    const okOption = (v: unknown) =>
      typeof v === 'string' && v.length > 0 && (spec.dynamicOptions === true || optionGids.has(v))
    const ok =
      spec.type === 'enum'
        ? okOption(value)
        : spec.type === 'multi_enum'
          ? Array.isArray(value) && value.length > 0 && value.every(okOption)
          : spec.type === 'text'
            ? typeof value === 'string'
            : false
    if (!ok) throw new DisallowedAsanaFieldError(`value for field ${fieldGid} is not allowed`)
  }
}

export function createAsanaProvider(token: string): TaskProvider {
  return {
    async createTask(payload: TaskPayload) {
      // HARD ALLOWLIST — runs before any fetch. A disallowed project
      // throws here and no network call is ever made.
      assertAllowedProject(payload.projectGid)
      // BETA FIELD BOUNDARY — also before any fetch.
      const customFields = hasCustomFields(payload.customFields) ? payload.customFields : undefined
      if (customFields) assertBetaCustomFields(payload.projectGid, customFields)

      const task = await createTaskInProject(token, {
        projectGid: payload.projectGid,
        sectionGid: payload.sectionGid,
        name: payload.name,
        notes: payload.notes,
        dueOn: payload.dueOn,
        ...(customFields ? { customFields } : {}),
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
