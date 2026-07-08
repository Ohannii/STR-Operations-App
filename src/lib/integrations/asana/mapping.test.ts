import { describe, it, expect } from 'vitest'
import {
  mapFlagToTaskPayload,
  isGuestChargeable,
  type FlagForMapping,
} from '@/lib/integrations/asana/mapping'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_TEST_SECTION_GIDS,
  ASANA_FALLBACK_SECTION_GID,
} from '@/lib/integrations/asana/config'

function baseFlag(overrides: Partial<FlagForMapping> = {}): FlagForMapping {
  return {
    id: 'flag-123',
    description: 'Leaking tap under kitchen sink',
    severity: 'med',
    categoryKey: 'maintenance_issue',
    categoryLabel: 'Broken thing',
    accountability: null,
    accountabilityLabel: 'Needs triage',
    propertyName: 'Ballito Villa 204',
    propertyId: 'prop-1',
    reporterName: 'Quraisha R.',
    raisedAtIso: '2026-07-08 14:32 (SAST)',
    status: 'Open',
    appBaseUrl: 'https://app.example.com',
    ...overrides,
  }
}

const ALL_CATEGORY_KEYS = [
  'maintenance_issue',
  'guest_damage',
  'inventory_missing',
  'inventory_damaged',
  'cleaning_issue',
  'safety_urgent',
  'owner_chargeable',
  'company_responsibility',
  'condition_note',
  'follow_up_required',
  'no_action_record',
  'totally_unknown_key',
]

describe('mapFlagToTaskPayload — project is always pinned', () => {
  it('every category targets ONLY the BETA test project', () => {
    for (const categoryKey of ALL_CATEGORY_KEYS) {
      const payload = mapFlagToTaskPayload(baseFlag({ categoryKey }))
      expect(payload.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    }
  })
})

describe('mapFlagToTaskPayload — category-based section routing', () => {
  it('routes by category group', () => {
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'maintenance_issue' })).sectionGid).toBe(
      ASANA_TEST_SECTION_GIDS.maintenance,
    )
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'guest_damage' })).sectionGid).toBe(
      ASANA_TEST_SECTION_GIDS.damage,
    )
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'inventory_damaged' })).sectionGid).toBe(
      ASANA_TEST_SECTION_GIDS.inventory,
    )
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'cleaning_issue' })).sectionGid).toBe(
      ASANA_TEST_SECTION_GIDS.cleaning,
    )
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'safety_urgent' })).sectionGid).toBe(
      ASANA_TEST_SECTION_GIDS.safety,
    )
  })

  it('routes owner_chargeable and unknown categories to Unsorted / Other', () => {
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'owner_chargeable' })).sectionGid).toBe(
      ASANA_FALLBACK_SECTION_GID,
    )
    expect(mapFlagToTaskPayload(baseFlag({ categoryKey: 'totally_unknown_key' })).sectionGid).toBe(
      ASANA_FALLBACK_SECTION_GID,
    )
  })

  it('does NOT override section for a guest-chargeable maintenance flag (beta rule)', () => {
    const payload = mapFlagToTaskPayload(
      baseFlag({
        categoryKey: 'maintenance_issue',
        accountability: 'guest_damage',
        accountabilityLabel: 'Guest damage',
      }),
    )
    // Stays in Maintenance — routing is category-based for the beta.
    expect(payload.sectionGid).toBe(ASANA_TEST_SECTION_GIDS.maintenance)
  })
})

describe('mapFlagToTaskPayload — task name', () => {
  it('formats "[Group] Property — summary"', () => {
    const payload = mapFlagToTaskPayload(baseFlag())
    expect(payload.name).toBe(
      '[Maintenance] Ballito Villa 204 — Leaking tap under kitchen sink',
    )
  })

  it('truncates long summaries and strips newlines', () => {
    const long = 'x'.repeat(120) + '\nsecond line should be dropped'
    const payload = mapFlagToTaskPayload(baseFlag({ description: long }))
    expect(payload.name).not.toContain('\n')
    expect(payload.name).not.toContain('second line')
    expect(payload.name).toContain('…')
    expect(payload.name.length).toBeLessThan(120)
  })
})

describe('mapFlagToTaskPayload — guest charge is unmissable', () => {
  it('adds [GUEST CHARGE] prefix + body marker when guest-chargeable', () => {
    const payload = mapFlagToTaskPayload(
      baseFlag({ accountability: 'guest_damage', accountabilityLabel: 'Guest damage' }),
    )
    expect(payload.name.startsWith('[GUEST CHARGE] ')).toBe(true)
    expect(payload.notes).toContain('GUEST CHARGE')
    expect(payload.notes).toMatch(/Chargeable to:\s+Guest damage/)
  })

  it('no guest prefix when not guest-chargeable', () => {
    const payload = mapFlagToTaskPayload(
      baseFlag({ accountability: 'owner_chargeable', accountabilityLabel: 'Owner-chargeable' }),
    )
    expect(payload.name.startsWith('[GUEST CHARGE]')).toBe(false)
    expect(payload.name.startsWith('[Maintenance]')).toBe(true)
  })

  it('isGuestChargeable detects canonical and legacy values', () => {
    expect(isGuestChargeable('guest_damage')).toBe(true)
    expect(isGuestChargeable('guest')).toBe(true)
    expect(isGuestChargeable('owner_chargeable')).toBe(false)
    expect(isGuestChargeable(null)).toBe(false)
  })
})

describe('mapFlagToTaskPayload — body + safety due date', () => {
  it('includes the app permalink and key fields', () => {
    const payload = mapFlagToTaskPayload(baseFlag())
    expect(payload.notes).toContain(
      'Open in app: https://app.example.com/properties/prop-1/flags/flag-123',
    )
    expect(payload.notes).toMatch(/Property:\s+Ballito Villa 204/)
    expect(payload.notes).toMatch(/Category:\s+Broken thing/)
    expect(payload.notes).toMatch(/Severity:\s+Medium/)
    expect(payload.notes).toMatch(/Status:\s+Open/)
  })

  it('strips a trailing slash from appBaseUrl', () => {
    const payload = mapFlagToTaskPayload(baseFlag({ appBaseUrl: 'https://app.example.com/' }))
    expect(payload.notes).toContain(
      'Open in app: https://app.example.com/properties/prop-1/flags/flag-123',
    )
  })

  it('sets dueOn only for safety flags when todayIso is provided', () => {
    const safety = mapFlagToTaskPayload(
      baseFlag({ categoryKey: 'safety_urgent', todayIso: '2026-07-08' }),
    )
    expect(safety.dueOn).toBe('2026-07-08')

    const nonSafety = mapFlagToTaskPayload(
      baseFlag({ categoryKey: 'maintenance_issue', todayIso: '2026-07-08' }),
    )
    expect(nonSafety.dueOn).toBeUndefined()
  })
})
