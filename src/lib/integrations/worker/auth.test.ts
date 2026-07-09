import { describe, it, expect } from 'vitest'
import { isValidTriggerSecret } from '@/lib/integrations/worker/auth'

describe('isValidTriggerSecret', () => {
  it('accepts a matching secret', () => {
    expect(isValidTriggerSecret('s3cret-value', 's3cret-value')).toBe(true)
  })

  it('rejects a mismatched secret', () => {
    expect(isValidTriggerSecret('wrong-value', 's3cret-value')).toBe(false)
  })

  it('rejects different lengths', () => {
    expect(isValidTriggerSecret('s3cret', 's3cret-value')).toBe(false)
  })

  it('fails closed when the expected secret is missing', () => {
    expect(isValidTriggerSecret('anything', undefined)).toBe(false)
    expect(isValidTriggerSecret('anything', '')).toBe(false)
  })

  it('fails closed when the provided secret is missing', () => {
    expect(isValidTriggerSecret(null, 's3cret-value')).toBe(false)
    expect(isValidTriggerSecret(undefined, 's3cret-value')).toBe(false)
    expect(isValidTriggerSecret('', 's3cret-value')).toBe(false)
  })
})
