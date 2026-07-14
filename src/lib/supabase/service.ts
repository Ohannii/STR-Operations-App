import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client. SERVER-ONLY — the `server-only` import
 * makes the build fail if this is ever pulled into a client bundle.
 *
 * It bypasses RLS, so it must be used ONLY in trusted server contexts.
 * Approved uses:
 *   - Slice 7: the Asana worker route, for narrowly-scoped staging reads.
 *   - Slice 11B-1 (Decision A): removeFlagPhotoObjects — deleting a
 *     pre-finalisation orphaned Storage object, since there is no broad
 *     storage.objects DELETE policy. Tightly fenced server-side (company
 *     resolved from the property, paths derived, refused once finalised).
 *   - Slice 11B-1 (collision guard): requestFlagPhotoUploadSlot uses it for
 *     two read-only existence probes (flags + photos by id) so soft-deleted
 *     / cross-company id collisions are detected before signing an upload
 *     URL. Runs only after auth + company + property-ownership checks;
 *     never writes.
 * The service-role key is read from the environment at call time and must
 * never reach the browser.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'Service client is not configured (missing Supabase URL or service role key).',
    )
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
