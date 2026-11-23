import type { SupabaseClient } from '@supabase/supabase-js'
import { assessHandoffHealth, parseHandoffHealth, type HandoffHealth } from './handoff-health'

/**
 * Why the check could not be made:
 *   'not_installed'  the health function does not exist on this database
 *                    (the migration is not applied — e.g. a preview);
 *   'error'          it exists but could not be read (outage, permission,
 *                    unexpected answer). Never means "issues failed".
 */
export type HandoffHealthUnavailable = { unavailable: 'not_installed' | 'error' }

const NOT_INSTALLED = new Set(['PGRST202', '42883'])

/** Managers only (enforced by the database function). Never throws. */
export async function loadHandoffHealth(
  supabase: SupabaseClient, companyId: string,
): Promise<HandoffHealth | HandoffHealthUnavailable> {
  try {
    const { data, error } = await supabase.rpc('asana_handoff_health', { p_company_id: companyId })
    if (error) return { unavailable: NOT_INSTALLED.has(error.code ?? '') ? 'not_installed' : 'error' }
    const raw = parseHandoffHealth(data)
    return raw ? assessHandoffHealth(raw) : { unavailable: 'error' }
  } catch {
    return { unavailable: 'error' }
  }
}
