import type { SupabaseClient } from '@supabase/supabase-js'
import { activeSessionFrom, type ActiveTestSession } from './test-mode'

/**
 * The signed-in person's active test session in this company, read through
 * RLS. Never throws: a missing table (migration pending) or a failed read
 * means "no banner", which is safe — classification itself is decided by
 * the database at issue creation, not by this read.
 */
export async function loadActiveTestSession(
  supabase: SupabaseClient, companyId: string, userId: string,
): Promise<ActiveTestSession | null> {
  try {
    const { data, error } = await supabase
      .from('test_sessions')
      .select('started_at, ends_at, ended_at, reason, property_id, property:properties(name)')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .is('ended_at', null)
      .limit(5)
    if (error) return null
    return activeSessionFrom(data)
  } catch {
    return null
  }
}
