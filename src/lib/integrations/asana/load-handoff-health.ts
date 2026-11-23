import type { SupabaseClient } from '@supabase/supabase-js'
import { assessHandoffHealth, parseHandoffHealth, type HandoffHealth } from './handoff-health'

/**
 * Managers only (enforced by the database function). Never throws:
 * 'unavailable' when the check could not be made (function missing before
 * the migration, permission, network) — the caller decides what to show.
 */
export async function loadHandoffHealth(supabase: SupabaseClient, companyId: string): Promise<HandoffHealth | 'unavailable'> {
  try {
    const { data, error } = await supabase.rpc('asana_handoff_health', { p_company_id: companyId })
    if (error) return 'unavailable'
    const raw = parseHandoffHealth(data)
    return raw ? assessHandoffHealth(raw) : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
