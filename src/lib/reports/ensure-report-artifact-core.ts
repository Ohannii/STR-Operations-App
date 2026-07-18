/**
 * PURE create-only / reuse / collision algorithm for report artifacts.
 *
 * Dependency-injected and framework-free: NO `server-only`, NO
 * createServiceClient, NO environment access. The server-only adapter
 * (ensure-report-artifact.ts) supplies a concrete `ArtifactStore` built on
 * the service-role Supabase client; this module is unit-testable on its own.
 */

/** True when a create-only upload failed because the object already exists. */
export function isReportConflict(
  error: { message?: string; statusCode?: string | number } | null | undefined,
): boolean {
  if (!error) return false
  if (String(error.statusCode ?? '') === '409') return true
  const msg = (error.message ?? '').toLowerCase()
  return (
    msg.includes('already exists') ||
    msg.includes('duplicate') ||
    msg.includes('resource already exists')
  )
}

/**
 * Minimal storage facade so the ensure logic is testable without Supabase.
 * `signExisting` returns a signed URL for an existing object, or null if it
 * does not exist. `createOnly` uploads with upsert=false.
 */
export type ArtifactStore = {
  signExisting: (path: string) => Promise<string | null>
  createOnly: (
    path: string,
    bytes: Buffer,
  ) => Promise<{ ok: boolean; conflict: boolean; error?: string }>
  /** Download the object bytes, or null if it does not exist. */
  download?: (path: string) => Promise<Buffer | null>
}

/**
 * Ensure the immutable artifact exists at `path`, then return a short-lived
 * signed download URL. Create-only + concurrent-collision safe:
 *   - already present → reuse (never re-render);
 *   - absent → render + create-only upload;
 *   - lost the create race (conflict) → load the winner and sign it.
 * We never render when the object already exists.
 */
export async function ensureAndSignArtifact(
  store: ArtifactStore,
  path: string,
  render: () => Promise<Buffer>,
): Promise<string> {
  const existing = await store.signExisting(path)
  if (existing) return existing

  const bytes = await render()
  const put = await store.createOnly(path, bytes)
  if (!put.ok && !put.conflict) {
    throw new Error(`report upload failed: ${put.error ?? 'unknown error'}`)
  }

  const signed = await store.signExisting(path)
  if (!signed) {
    throw new Error('report artifact could not be signed after write')
  }
  return signed
}

/**
 * Ensure the immutable artifact exists at `path` and RETURN ITS BYTES (for
 * server-side consumers like the Asana attach worker). Create-only + reuse:
 *   - already present → download the stored bytes (never re-render);
 *   - absent → render + create-only upload → return the rendered bytes;
 *   - lost the create race → download the winner's bytes.
 * Requires a store with `download`.
 */
export async function ensureArtifactBytes(
  store: ArtifactStore,
  path: string,
  render: () => Promise<Buffer>,
): Promise<Buffer> {
  if (!store.download) throw new Error('store does not support download')

  const existing = await store.download(path)
  if (existing) return existing

  const bytes = await render()
  const put = await store.createOnly(path, bytes)
  if (put.ok) return bytes
  if (!put.conflict) {
    throw new Error(`report upload failed: ${put.error ?? 'unknown error'}`)
  }
  // Lost the race → load the winner's bytes.
  const winner = await store.download(path)
  if (!winner) throw new Error('report artifact vanished after conflict')
  return winner
}
