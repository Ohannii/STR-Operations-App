import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser-side Supabase client.
 * Safe to call from Client Components — uses the public anon key.
 * RLS policies on the database enforce all data access rules.
 *
 * Usage:
 *   const supabase = createClient()
 *   const { data } = await supabase.from('inspections').select()
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
