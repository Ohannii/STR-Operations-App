/**
 * EXACT single-object presence check for one Storage path (photo perf fix).
 *
 * Replaces folder listing (`.list()`), which on this project runs
 * storage.search() as a full scan of every stored object under RLS
 * (measured 12–21 s). `info(path)` is an exact-name lookup.
 *
 * Tri-state, FAIL CLOSED:
 *   - 'present' — the API returned the object's metadata;
 *   - 'missing' — the API answered with its specific missing-OBJECT result;
 *   - 'unknown' — anything else (auth, permission, rate limit, server,
 *                 network, malformed, or an unrecognised error). Callers
 *                 must treat 'unknown' as "cannot decide": no upload links.
 *
 * Why info() and not exists(): exists() is a HEAD request. A HEAD error has
 * no body, so the SDK (storage-js 2.106.1) only sees the HTTP status — and
 * this Storage server answers a missing object with HTTP 400 (observed in
 * the project's storage logs), the same status as other bad requests. So a
 * HEAD result cannot distinguish "missing" from other 400s. info() is a GET
 * whose error BODY the SDK parses into StorageApiError: for a missing object
 * the server returns HTTP 400 with body statusCode "404" and message
 * "Object not found" (observed, storage api 1.84.25). That exact
 * combination — and only that — is 'missing'. A missing BUCKET (also body
 * statusCode "404", message "Bucket not found") is NOT 'missing'.
 */

export type ObjectPresence = 'present' | 'missing' | 'unknown'

/** The one Storage method this module needs (structural, for testing). */
export type ObjectInfoApi = {
  info: (path: string) => Promise<{ data: unknown; error: unknown }>
}

/**
 * True ONLY for the Storage API's specific missing-object error: a parsed
 * StorageApiError (HTTP 400 or 404) whose body statusCode is "404" and whose
 * message is "Object not found".
 */
export function isStorageObjectNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
  return (
    e.name === 'StorageApiError' &&
    (e.status === 400 || e.status === 404) &&
    e.statusCode === '404' &&
    typeof e.message === 'string' &&
    e.message.trim().toLowerCase() === 'object not found'
  )
}

/** Exact presence of ONE object. Never throws. */
export async function exactObjectPresence(
  storage: ObjectInfoApi,
  path: string,
): Promise<ObjectPresence> {
  try {
    const { data, error } = await storage.info(path)
    if (!error) return data !== null && typeof data === 'object' ? 'present' : 'unknown'
    return isStorageObjectNotFound(error) ? 'missing' : 'unknown'
  } catch {
    return 'unknown'
  }
}
