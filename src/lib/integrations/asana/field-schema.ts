/**
 * Asana custom-field schema LOADING (Phase 1, hardened) — the only I/O around
 * field validation, and it is READ-ONLY (one paginated GET).
 *
 * NEVER THROWS. Any failure to read the schema — 401/403/404, 429, 5xx, a
 * network error, malformed JSON, a malformed / looping page — yields a
 * validation with NO usable fields and one `schema_unavailable` issue
 * (HTTP status only; never a response body, message or token). A schema
 * problem must cost the task its custom fields, never the task itself.
 *
 * Wired into the worker through createWritableFieldValidationLoader: ONE
 * lazy, memoised load per worker HTTP request, never one per task.
 */

import { AsanaApiError, getProjectCustomFieldSettings } from '@/lib/integrations/asana/client'
import type { ProjectFieldConfig, WritableFieldConfig } from '@/lib/integrations/asana/field-config'
import {
  emptyValidation,
  unavailableWritableValidation,
  validateFieldConfig,
  validateWritableFieldConfig,
  type FieldIssue,
  type FieldValidation,
  type WritableFieldValidation,
} from '@/lib/integrations/asana/field-validation'

type FetchSchema = (token: string, projectGid: string) => Promise<unknown>

function unavailableIssue(err: unknown): FieldIssue {
  const status = err instanceof AsanaApiError ? err.status : undefined
  return {
    code: 'schema_unavailable',
    ...(status !== undefined ? { status } : {}),
    detail:
      status !== undefined
        ? `Project field schema could not be read (HTTP ${status}).`
        : 'Project field schema could not be read (network error or malformed response).',
  }
}

/** WRITE PATH (BETA only, enforced by the writable brand + allowlist). */
export async function loadWritableFieldValidation(
  token: string,
  config: WritableFieldConfig,
  fetchSchema: FetchSchema = getProjectCustomFieldSettings,
): Promise<WritableFieldValidation> {
  let metadata: unknown
  try {
    metadata = await fetchSchema(token, config.projectGid)
  } catch (err) {
    return unavailableWritableValidation(config, unavailableIssue(err))
  }
  return validateWritableFieldConfig(config, metadata)
}

/**
 * ONE lazy, memoised writable validation per worker HTTP request. The first
 * call starts the (read-only) schema load; every later call — success OR
 * failure — returns that same result, so a batch of creates costs at most
 * one schema read and a failed read is not retried within the request.
 * Never rejects (loadWritableFieldValidation never throws).
 */
export function createWritableFieldValidationLoader(
  token: string,
  config: WritableFieldConfig,
  fetchSchema: FetchSchema = getProjectCustomFieldSettings,
): () => Promise<WritableFieldValidation> {
  let pending: Promise<WritableFieldValidation> | null = null
  return () => (pending ??= loadWritableFieldValidation(token, config, fetchSchema))
}

/** INSPECTION (any project, e.g. the live reference). Read-only; never writable. */
export async function inspectFieldConfig(
  token: string,
  config: ProjectFieldConfig,
  fetchSchema: FetchSchema = getProjectCustomFieldSettings,
): Promise<FieldValidation> {
  let metadata: unknown
  try {
    metadata = await fetchSchema(token, config.projectGid)
  } catch (err) {
    return emptyValidation(config.projectGid, unavailableIssue(err))
  }
  return validateFieldConfig(config, metadata)
}
