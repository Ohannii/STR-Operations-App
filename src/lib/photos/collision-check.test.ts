import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFlagPhotoCollision } from '@/lib/photos/collision-check'

const FLAG = '11111111-1111-4111-8111-111111111111'
const PHOTO = '22222222-2222-4222-8222-222222222222'

type Row = { data: unknown; error: unknown }

/**
 * Fake Supabase client that also records whether `.is()` (a deleted_at
 * filter) was ever applied per table, so we can PROVE the collision guard
 * does not filter out soft-deleted rows.
 */
function fakeClient(rows: { flags?: Row; photos?: Row }) {
  const isCalledByTable: Record<string, boolean> = {}
  const client = {
    from(table: string) {
      isCalledByTable[table] = isCalledByTable[table] ?? false
      const q = {
        select: () => q,
        eq: () => q,
        is: () => {
          isCalledByTable[table] = true
          return q
        },
        maybeSingle: async () =>
          (rows as Record<string, Row>)[table] ?? { data: null, error: null },
      }
      return q
    },
  } as unknown as SupabaseClient
  return { client, isCalledByTable }
}

describe('checkFlagPhotoCollision', () => {
  it('rejects when a flag row already exists', async () => {
    const { client } = fakeClient({ flags: { data: { id: FLAG }, error: null } })
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/flag has already been used/i)
  })

  it('rejects when a photo row already exists', async () => {
    const { client } = fakeClient({ photos: { data: { id: PHOTO }, error: null } })
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/already in use/i)
  })

  it('rejects a SOFT-DELETED collision and never filters on deleted_at', async () => {
    // A soft-deleted flag row still comes back because the guard does not
    // apply `.is('deleted_at', null)`.
    const { client, isCalledByTable } = fakeClient({
      flags: { data: { id: FLAG, deleted_at: '2026-01-01T00:00:00Z' }, error: null },
    })
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(false)
    expect(isCalledByTable.flags).toBe(false) // proves no deleted_at filter
  })

  it('allows a safe retry of a partially uploaded, unfinalised photo', async () => {
    // Pre-finalisation: neither row exists → slots may be (re)issued.
    const { client } = fakeClient({})
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(true)
  })

  it('finalised evidence (both rows present) can never be overwritten', async () => {
    const { client } = fakeClient({
      flags: { data: { id: FLAG }, error: null },
      photos: { data: { id: PHOTO }, error: null },
    })
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(false)
  })

  it('surfaces a probe error rather than proceeding', async () => {
    const { client } = fakeClient({
      flags: { data: null, error: { message: 'db down' } },
    })
    const res = await checkFlagPhotoCollision(client, {
      proposedFlagId: FLAG,
      photoId: PHOTO,
    })
    expect(res.ok).toBe(false)
  })
})
