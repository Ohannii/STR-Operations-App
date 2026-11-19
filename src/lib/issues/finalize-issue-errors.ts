import { PHOTOS_NOT_UPLOADED_MESSAGE, isMissingEvidenceObjectError } from '@/lib/photos/finalize-helpers'

/**
 * Safe, specific messages for finalize_flag_issue_with_photos refusals.
 * Returns null for anything not recognised (the caller's existing generic
 * handling applies). Never returns raw database text.
 */
export function finalizeIssueErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const e = error as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const msg = typeof e.message === 'string' ? e.message : ''
  if (isMissingEvidenceObjectError(error)) return PHOTOS_NOT_UPLOADED_MESSAGE
  // The migration that adds issue reporting has not been applied yet.
  if (code === 'PGRST202' || code === '42883' || (/finalize_flag_issue_with_photos/.test(msg) && code === '42P01')) {
    return 'Issue reporting is not switched on yet (database update pending). Please tell Anni.'
  }
  if (code === '23505' && /different selections/.test(msg)) {
    return 'This issue was already saved with different details. Close the form and check the saved issue.'
  }
  if (code === 'P0002' && /source pack photo/.test(msg)) {
    return 'That pack photo could not be found for this apartment.'
  }
  if (code === '22023' || code === '23514') {
    return 'Some of the issue details are not valid. Check your selections and try again.'
  }
  return null
}
