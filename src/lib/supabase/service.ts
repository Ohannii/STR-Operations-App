import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client. SERVER-ONLY — the `server-only` import
 * makes the build fail if this is ever pulled into a client bundle.
 *
 * It bypasses RLS, so it must be used ONLY in trusted server contexts.
 * Approved (Slice 7) solely for the Asana dry-run worker route, for
 * narrowly-scoped staging reads. The service-role key is read from the
 * environment at call time and must never reach the browser.
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
