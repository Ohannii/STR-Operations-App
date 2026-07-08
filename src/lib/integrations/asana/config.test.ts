import { describe, it, expect } from 'vitest'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_FALLBACK_SECTION_GID,
  ASANA_TEST_SECTION_GIDS,
  assertAllowedProject,
  sectionGidForGroup,
  DisallowedAsanaProjectError,
} from '@/lib/integrations/asana/config'

describe('assertAllowedProject (hard allowlist)', () => {
  it('allows the pinned BETA test project', () => {
    expect(() => assertAllowedProject(ASANA_TEST_PROJECT_GID)).not.toThrow()
  })

  it('throws for known LIVE projects', () => {
    // Incidents & Damages Reporting (live)
    expect(() => assertAllowedProject('1211426202387126')).toThrow(
      DisallowedAsanaProjectError,
    )
    // Maintenance Control (live)
    expect(() => assertAllowedProject('1208811122490679')).toThrow()
  })

  it('throws for empty / bogus project ids', () => {
    expect(() => assertAllowedProject('')).toThrow()
    expect(() => assertAllowedProject('9999')).toThrow()
  })
})

describe('sectionGidForGroup', () => {
  it('maps each known category group to its section', () => {
    expect(sectionGidForGroup('damage')).toBe(ASANA_TEST_SECTION_GIDS.damage)
    expect(sectionGidForGroup('maintenance')).toBe(ASANA_TEST_SECTION_GIDS.maintenance)
    expect(sectionGidForGroup('inventory')).toBe(ASANA_TEST_SECTION_GIDS.inventory)
    expect(sectionGidForGroup('cleaning')).toBe(ASANA_TEST_SECTION_GIDS.cleaning)
    expect(sectionGidForGroup('safety')).toBe(ASANA_TEST_SECTION_GIDS.safety)
    expect(sectionGidForGroup('notes')).toBe(ASANA_TEST_SECTION_GIDS.notes)
  })

  it('routes owner_chargeable to Unsorted / Other for the beta', () => {
    expect(sectionGidForGroup('owner_chargeable')).toBe(ASANA_FALLBACK_SECTION_GID)
  })

  it('falls back to Unsorted / Other for null or unknown groups', () => {
    expect(sectionGidForGroup(null)).toBe(ASANA_FALLBACK_SECTION_GID)
    expect(sectionGidForGroup('nonsense')).toBe(ASANA_FALLBACK_SECTION_GID)
  })
})
