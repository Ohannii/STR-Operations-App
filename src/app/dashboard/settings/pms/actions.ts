'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { connectedPmsSetup, databaseFailure, PmsSetupError, pmsFailure, readPmsSetup, requirePmsAdmin } from '@/lib/pms/setup-server'
import { exchangeHostawayCredentials, providerId, readHostawayListings, readHostawayUnits, type HostawayListing, type HostawayUnit } from '@/lib/pms/hostaway'
import type { PmsResult, PmsSetup } from '@/lib/pms/setup-types'
import { validId } from '@/lib/inspections/workboard'

const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0
const refresh = () => revalidatePath('/dashboard/settings/pms')

export async function connectHostaway(input: { accountId: string; apiKey: string; revision: number }): Promise<PmsResult<PmsSetup>> {
  try {
    const { companyId, actorId } = await requirePmsAdmin()
    if (!input || typeof input.accountId !== 'string' || typeof input.apiKey !== 'string' || !providerId(input.accountId.trim())
      || !input.apiKey.trim() || input.apiKey.length > 4096 || !validRevision(input.revision)) throw new PmsSetupError('invalid_input')
    // Check schema/revision/account BEFORE exchanging credentials. A pending
    // database deployment must not create provider tokens or collect secrets.
    const before = await readPmsSetup(companyId)
    if ((before.connection?.revision ?? 0) !== input.revision) throw new PmsSetupError('stale_setup')
    if (before.connection && before.connection.account_id !== input.accountId.trim()) throw new PmsSetupError('connection_unavailable')
    const { token, expiresAt } = await exchangeHostawayCredentials(input.accountId.trim(), input.apiKey)
    const saved = await createServiceClient().rpc('save_hostaway_connection', {
      p_company_id: companyId, p_actor_id: actorId, p_account_id: input.accountId.trim(), p_access_token: token,
      p_expires_at: expiresAt, p_expected_revision: input.revision,
    })
    if (saved.error) databaseFailure(saved.error)
    if (!validId(saved.data)) throw new PmsSetupError('confirmation_unavailable')
    refresh()
    return { ok: true, data: await readPmsSetup(companyId) }
  } catch (error) { return pmsFailure(error) }
}

export async function loadHostawayListings(revision: number): Promise<PmsResult<HostawayListing[]>> {
  try {
    const { companyId, actorId } = await requirePmsAdmin()
    const { token } = await connectedPmsSetup(companyId, actorId, revision)
    return { ok: true, data: await readHostawayListings(token) }
  } catch (error) { return pmsFailure(error) }
}

export async function loadHostawayUnits(input: { listingId: string; revision: number }): Promise<PmsResult<HostawayUnit[]>> {
  try {
    const { companyId, actorId } = await requirePmsAdmin()
    if (!input || !providerId(input.listingId)) throw new PmsSetupError('invalid_input')
    const { token } = await connectedPmsSetup(companyId, actorId, input.revision)
    if (!(await readHostawayListings(token)).some(l => l.id === input.listingId)) throw new PmsSetupError('invalid_input')
    return { ok: true, data: await readHostawayUnits(token, input.listingId) }
  } catch (error) { return pmsFailure(error) }
}

export async function saveHostawayMapping(input: {
  listingId: string; unitId: string; propertyId: string; connectionRevision: number; mappingRevision: number; physicalListingConfirmed: boolean
}): Promise<PmsResult<PmsSetup>> {
  try {
    const { companyId, actorId } = await requirePmsAdmin()
    if (!input || !providerId(input.listingId) || (input.unitId !== '0' && !providerId(input.unitId))
      || !validId(input.propertyId) || !validRevision(input.mappingRevision)) throw new PmsSetupError('invalid_input')
    const { setup, connection, token, service } = await connectedPmsSetup(companyId, actorId, input.connectionRevision)
    if (!setup.properties.some(p => p.id === input.propertyId)) throw new PmsSetupError('not_authorized')
    const listing = (await readHostawayListings(token)).find(l => l.id === input.listingId)
    if (!listing) throw new PmsSetupError('invalid_input')
    const units = await readHostawayUnits(token, listing.id)
    const unit = units.find(u => u.id === input.unitId)
    if (units.length ? !unit : input.unitId !== '0' || input.physicalListingConfirmed !== true) throw new PmsSetupError('physical_unit_required')
    const result = await service.rpc('save_hostaway_mapping', {
      p_company_id: companyId, p_actor_id: actorId, p_connection_id: connection.id, p_connection_revision: connection.revision,
      p_listing_id: listing.id, p_unit_id: unit?.id ?? '0', p_property_id: input.propertyId,
      p_listing_name: listing.name, p_unit_name: unit?.name ?? null, p_time_zone: listing.timeZone,
      p_expected_revision: input.mappingRevision,
    })
    if (result.error) databaseFailure(result.error)
    if (!validId(result.data)) throw new PmsSetupError('confirmation_unavailable')
    refresh()
    return { ok: true, data: await readPmsSetup(companyId) }
  } catch (error) { return pmsFailure(error) }
}

export async function disconnectHostaway(revision: number): Promise<PmsResult<PmsSetup>> {
  try {
    const { companyId, actorId } = await requirePmsAdmin()
    const setup = await readPmsSetup(companyId)
    if (!setup.connection) throw new PmsSetupError('connection_unavailable')
    const result = await createServiceClient().rpc('disconnect_hostaway_connection', {
      p_company_id: companyId, p_actor_id: actorId, p_connection_id: setup.connection.id, p_revision: revision,
    })
    if (result.error) databaseFailure(result.error)
    refresh()
    return { ok: true, data: await readPmsSetup(companyId) }
  } catch (error) { return pmsFailure(error) }
}
