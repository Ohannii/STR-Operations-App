import 'server-only'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { HostawayError } from './hostaway'
import type { PmsConnection, PmsMapping, PmsProperty, PmsResult, PmsSetup } from './setup-types'

export class PmsSetupError extends Error {
  constructor(public code: string) { super(code) }
}
export async function requirePmsAdmin() {
  const ctx = await getUserContext()
  if (!ctx?.company || !ctx.membership || ctx.membership.role_key !== 'company_admin'
    || ctx.membership.company_id !== ctx.company.id) throw new PmsSetupError('not_authorized')
  return { companyId: ctx.company.id, actorId: ctx.user.id }
}
export function databaseFailure(error: { code?: string } | null) {
  if (['42P01', 'PGRST202', 'PGRST205', '42883'].includes(error?.code ?? '')) throw new PmsSetupError('database_pending')
  if (error?.code === '42501') throw new PmsSetupError('not_authorized')
  if (error?.code === '40001') throw new PmsSetupError('stale_setup')
  if (error?.code === '55000') throw new PmsSetupError('connection_unavailable')
  if (error?.code === '23505') throw new PmsSetupError('mapping_conflict')
  throw new PmsSetupError('confirmation_unavailable')
}
export function pmsFailure<T>(error: unknown): PmsResult<T> {
  const code = error instanceof PmsSetupError || error instanceof HostawayError ? error.code : 'confirmation_unavailable'
  const messages: Record<string, string> = {
    not_authorized: 'Company admin access is required to manage the booking connection.',
    database_pending: 'Booking connection setup is not switched on yet. Please contact Anni.',
    stale_setup: 'This setup changed on another device. Reload before saving again.',
    connection_unavailable: 'Reconnect the same Hostaway account, then reload its listings. Changing accounts needs a reviewed transfer.',
    credentials_rejected: 'Hostaway did not accept these details. Check the Account ID and API key.',
    rate_limited: 'Hostaway is busy. Wait a moment, then try again.',
    unavailable: 'Hostaway could not be reached. Please try again.',
    invalid_response: 'Hostaway returned data we could not verify. Nothing from this response was saved.',
    incomplete_response: 'The Hostaway listing list was incomplete. Please reload it before mapping apartments.',
    invalid_input: 'Check the account, listing and apartment details before saving.',
    physical_unit_required: 'Choose a specific Hostaway subunit, or confirm that this listing represents one physical apartment.',
    mapping_conflict: 'This apartment or listing already has a conflicting match. Reload and check the existing matches before changing it.',
    confirmation_unavailable: 'We could not confirm the latest setup. Reload before retrying.',
  }
  return { ok: false, code, error: messages[code] ?? messages.confirmation_unavailable }
}

export async function readPmsSetup(companyId: string): Promise<PmsSetup> {
  const sb = await createClient()
  const [connection, properties] = await Promise.all([
    sb.from('pms_connections').select('id,provider,account_id,status,credential_expires_at,revision').eq('company_id', companyId).eq('provider', 'hostaway').maybeSingle(),
    sb.from('properties').select('id,name,address,unit_reference').eq('company_id', companyId).is('deleted_at', null).order('name'),
  ])
  if (connection.error) databaseFailure(connection.error)
  if (properties.error) databaseFailure(properties.error)
  let mappings: PmsMapping[] = []
  if (connection.data) {
    const result = await sb.from('pms_listing_mappings').select('id,listing_id,unit_id,listing_name,unit_name,time_zone,property_id,revision,verified_at')
      .eq('company_id', companyId).eq('connection_id', connection.data.id).order('listing_name')
    if (result.error) databaseFailure(result.error)
    mappings = result.data as PmsMapping[]
  }
  return { connection: connection.data as PmsConnection | null, properties: properties.data as PmsProperty[], mappings }
}
export async function connectedPmsSetup(companyId: string, actorId: string, revision: number) {
  const setup = await readPmsSetup(companyId), c = setup.connection
  if (!c || c.status !== 'connected' || !c.credential_expires_at || Date.parse(c.credential_expires_at) <= Date.now()) throw new PmsSetupError('connection_unavailable')
  if (c.revision !== revision) throw new PmsSetupError('stale_setup')
  const service = createServiceClient()
  const result = await service.rpc('read_hostaway_setup_token', { p_company_id: companyId, p_actor_id: actorId, p_connection_id: c.id, p_revision: c.revision })
  if (result.error) databaseFailure(result.error)
  if (typeof result.data !== 'string' || result.data.length < 16) throw new PmsSetupError('connection_unavailable')
  return { setup, connection: c, token: result.data, service }
}
