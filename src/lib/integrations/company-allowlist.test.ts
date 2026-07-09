import { describe, it, expect } from 'vitest'
import {
  assertAllowedCompany,
  parseAllowedCompanyIds,
  DisallowedCompanyError,
} from '@/lib/integrations/company-allowlist'

const APPROVED = 'company-approved-1'
const OTHER = 'company-other-2'

describe('assertAllowedCompany (fail closed)', () => {
  it('passes when the company is on the allowlist', () => {
    expect(() => assertAllowedCompany(APPROVED, [APPROVED])).not.toThrow()
    expect(() => assertAllowedCompany(APPROVED, [OTHER, APPROVED])).not.toThrow()
  })

  it('throws for a company not on the allowlist', () => {
    expect(() => assertAllowedCompany(OTHER, [APPROVED])).toThrow(DisallowedCompanyError)
  })

  it('throws when the allowlist is empty (fail closed)', () => {
    expect(() => assertAllowedCompany(APPROVED, [])).toThrow(DisallowedCompanyError)
  })

  it('throws for an empty company id', () => {
    expect(() => assertAllowedCompany('', [APPROVED])).toThrow(DisallowedCompanyError)
  })
})

describe('parseAllowedCompanyIds', () => {
  it('returns [] for undefined / empty / whitespace input', () => {
    expect(parseAllowedCompanyIds(undefined)).toEqual([])
    expect(parseAllowedCompanyIds('')).toEqual([])
    expect(parseAllowedCompanyIds('   ')).toEqual([])
  })

  it('splits, trims, and drops blank entries', () => {
    expect(parseAllowedCompanyIds('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(parseAllowedCompanyIds('a,,b, ,c')).toEqual(['a', 'b', 'c'])
  })

  it('dedupes repeated ids', () => {
    expect(parseAllowedCompanyIds('a,a,b')).toEqual(['a', 'b'])
  })

  it('round-trips with the guard', () => {
    const allowed = parseAllowedCompanyIds('c1, c2')
    expect(() => assertAllowedCompany('c2', allowed)).not.toThrow()
    expect(() => assertAllowedCompany('c3', allowed)).toThrow(DisallowedCompanyError)
  })
})
