import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * How the database classified a just-created flag:
 *   'test'    stamped as a test issue (test apartment / manager test mode);
 *   'normal'  stamped as a normal issue;
 *   'unknown' the read failed — the caller must NOT guess a destination.
 *
 * Read separately (not in the insert's RETURNING) so issue creation keeps
 * working whatever happens to this read. A missing column (42703) means the
 * test-isolation migration is not applied yet: nothing can be a test issue
 * then, so it is 'normal' (exactly the pre-migration behaviour).
 */
export type FlagTestClassification = 'test' | 'normal' | 'unknown'

export async function readFlagTestClassification(supabase: SupabaseClient, flagId: string): Promise<FlagTestClassification> {
  try {
    const { data, error } = await supabase
      .from('flags')
      .select('is_test')
      .eq('id', flagId)
      .maybeSingle<{ is_test: boolean }>()
    if (error) return error.code === '42703' ? 'normal' : 'unknown'
    if (!data || typeof data.is_test !== 'boolean') return 'unknown'
    return data.is_test ? 'test' : 'normal'
  } catch {
    return 'unknown'
  }
}
