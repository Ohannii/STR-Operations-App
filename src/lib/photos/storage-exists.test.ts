import { describe, it, expect, vi } from 'vitest'
import { verifiedObjectExists, type StorageFileApiLike } from '@/lib/photos/storage-exists'

describe('verifiedObjectExists -- positive proof, never error-text guessing', () => {
  it('PREFERRED path: exists() true -> uploaded; exists() false -> NOT uploaded', async () => {
    const yes: StorageFileApiLike = {
      exists: vi.fn(async () => ({ data: true, error: null })),
      createSignedUrl: vi.fn(async () => ({ data: null, error: null })),
    }
    expect(await verifiedObjectExists(yes, 'a.jpg')).toBe(true)
    expect(yes.createSignedUrl).not.toHaveBeenCalled() // exists() answered

    const no: StorageFileApiLike = {
      exists: vi.fn(async () => ({ data: false, error: null })),
      createSignedUrl: vi.fn(async () => ({ data: null, error: null })),
    }
    // The duplicate-error HINT is not enough: a definite false wins.
    expect(await verifiedObjectExists(no, 'a.jpg')).toBe(false)
    expect(no.createSignedUrl).not.toHaveBeenCalled()
  })

  it('FALLBACK path (no exists()): signed-download probe succeeds for a real object, fails for a missing one', async () => {
    const real: StorageFileApiLike = {
      createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'x' }, error: null })),
    }
    expect(await verifiedObjectExists(real, 'real.jpg')).toBe(true)

    const missing: StorageFileApiLike = {
      createSignedUrl: vi.fn(async () => ({
        data: null,
        error: { message: 'Object not found' },
      })),
    }
    expect(await verifiedObjectExists(missing, 'missing.jpg')).toBe(false)
  })

  it('an erroring exists() falls back to the probe instead of guessing', async () => {
    const flaky: StorageFileApiLike = {
      exists: vi.fn(async () => ({ data: null, error: { message: 'network' } })),
      createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'x' }, error: null })),
    }
    expect(await verifiedObjectExists(flaky, 'a.jpg')).toBe(true)
    expect(flaky.createSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('total API failure yields NOT uploaded (fail closed, never text-based)', async () => {
    const dead: StorageFileApiLike = {
      exists: vi.fn(async () => {
        throw new Error('boom')
      }),
      createSignedUrl: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    expect(await verifiedObjectExists(dead, 'a.jpg')).toBe(false)
  })
})
