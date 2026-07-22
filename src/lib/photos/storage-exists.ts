/**
 * POSITIVE object-existence proof (P0 acceptance, 23 Jul).
 *
 * A duplicate error string from create-only signing is a HINT, never proof:
 * classifying an object as uploaded from error text alone could mark a photo
 * "already staged" that was never stored. This verifier gives a positive
 * answer from the storage API itself:
 *   1. PREFERRED: Supabase Storage `exists(path)` (official existence check)
 *      when the installed client provides it;
 *   2. FALLBACK: `createSignedUrl(path, 60)` — signing a download succeeds
 *      only for a real object and errors for a missing one.
 * Only a definite true from one of these classifies the object as uploaded.
 */

export type StorageFileApiLike = {
  exists?: (path: string) => Promise<{ data: boolean | null; error: unknown | null }>
  createSignedUrl: (
    path: string,
    expiresIn: number,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>
}

export async function verifiedObjectExists(
  storage: StorageFileApiLike,
  path: string,
): Promise<boolean> {
  if (typeof storage.exists === 'function') {
    try {
      const { data, error } = await storage.exists(path)
      if (!error) return data === true // definite yes/no from the API
      // API errored (network/permission): fall through to the probe rather
      // than guessing.
    } catch {
      // same: fall through
    }
  }
  try {
    const { error } = await storage.createSignedUrl(path, 60)
    return !error
  } catch {
    return false // no positive proof -> not uploaded
  }
}
