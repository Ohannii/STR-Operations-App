export type PmsConnection = {
  id: string; provider: 'hostaway'; account_id: string; status: 'connected' | 'disconnected'
  credential_expires_at: string | null; revision: number
}
export type PmsMapping = {
  id: string; listing_id: string; unit_id: string; listing_name: string; unit_name: string | null
  time_zone: string | null; property_id: string; revision: number; verified_at: string
}
export type PmsProperty = { id: string; name: string; address: string | null; unit_reference: string | null }
export type PmsSetup = { connection: PmsConnection | null; mappings: PmsMapping[]; properties: PmsProperty[] }
export type PmsResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string }
