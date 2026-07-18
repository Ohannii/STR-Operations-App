/**
 * Pure, I/O-free helpers for the dashboard property finder
 * (feat/property-finder-mobile). Estate classification, natural
 * numerical ordering, and search/filter composition all live here so
 * they're deterministic and unit-testable; the client component
 * (property-finder.tsx) is a thin presentation layer over these.
 *
 * No database column carries the estate today, so estate membership is
 * DERIVED from the property's text (name + unit_reference + address).
 * See classifyEstate for the exact matching rule.
 */

/** The estates we recognise, plus the catch-all for everything else. */
export type EstateKey = 'ballito_life' | 'ballito_village' | 'other'

/** UI filter value: an estate, or "all". */
export type EstateFilter = 'all' | EstateKey

/** The minimal property shape the finder reasons about. */
export type FinderProperty = {
  id: string
  name: string
  address: string | null
  unit_reference: string | null
  status: string
  bedrooms: number | null
}

/** Human labels for each estate (also used as searchable text). */
export const ESTATE_LABEL: Record<EstateKey, string> = {
  ballito_life: 'Ballito Life',
  ballito_village: 'Ballito Village',
  other: 'Other',
}

/**
 * Estate matchers, checked IN ORDER. Each `needle` is compared against
 * the property's text after collapsing to lowercase alphanumerics only
 * (so "Ballito Life", "BallitoLife", "ballito-life", "BALLITO  LIFE"
 * all collapse to "ballitolife" and match). Village is listed first for
 * clarity, though the two needles are mutually exclusive.
 */
const ESTATE_MATCHERS: { key: EstateKey; needle: string }[] = [
  { key: 'ballito_village', needle: 'ballitovillage' },
  { key: 'ballito_life', needle: 'ballitolife' },
]

/** Lowercase and strip everything but a–z / 0–9 (spaces, dashes, punctuation). */
function collapseAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

type EstateFields = Pick<FinderProperty, 'name' | 'address' | 'unit_reference'>

/**
 * Classify a property into an estate by scanning its combined text.
 * A property matches an estate only if the estate's FULL collapsed name
 * appears (a bare "Ballito" is not enough), so unmatched / test
 * properties fall through to 'other' and are never hidden.
 */
export function classifyEstate(p: EstateFields): EstateKey {
  const haystack = collapseAlnum(
    [p.name, p.unit_reference, p.address].filter(Boolean).join(' '),
  )
  for (const m of ESTATE_MATCHERS) {
    if (haystack.includes(m.needle)) return m.key
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Natural numerical ordering
// ---------------------------------------------------------------------------

type Chunk = { num: number | null; text: string }

/** Split a normalized string into alternating number / non-number chunks. */
function chunks(normalized: string): Chunk[] {
  const parts = normalized.match(/\d+|\D+/g) ?? []
  return parts.map((p) =>
    /^\d+$/.test(p) ? { num: Number.parseInt(p, 10), text: p } : { num: null, text: p },
  )
}

/**
 * Natural (human) comparison: numeric runs compare by VALUE, so
 * "2" < "10" < "95" < "102". Case-insensitive and whitespace-collapsed.
 * Numeric chunks sort before alphabetic ones at the same position (so a
 * bare "95" sorts ahead of "Test 1"). Fully deterministic — ties fall
 * back to a raw string comparison so the sort is stable across engines.
 */
export function naturalCompare(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, ' ').trim()
  const nb = b.toLowerCase().replace(/\s+/g, ' ').trim()
  const ca = chunks(na)
  const cb = chunks(nb)
  const n = Math.min(ca.length, cb.length)
  for (let i = 0; i < n; i++) {
    const x = ca[i]
    const y = cb[i]
    if (x.num !== null && y.num !== null) {
      if (x.num !== y.num) return x.num - y.num
      // Same value, different spelling (e.g. "02" vs "2") — shorter first.
      if (x.text.length !== y.text.length) return x.text.length - y.text.length
    } else if (x.num !== null) {
      return -1 // number before letters
    } else if (y.num !== null) {
      return 1
    } else if (x.text !== y.text) {
      return x.text < y.text ? -1 : 1
    }
  }
  if (ca.length !== cb.length) return ca.length - cb.length
  // Fully equal after normalization → equal (keep it case-insensitive;
  // compare the normalized forms, never the raw case-sensitive input).
  return na < nb ? -1 : na > nb ? 1 : 0
}

/**
 * Deterministic property ordering: natural by name, then unit reference,
 * then id as a final stable tiebreak.
 */
export function compareProperties(a: FinderProperty, b: FinderProperty): number {
  const byName = naturalCompare(a.name ?? '', b.name ?? '')
  if (byName !== 0) return byName
  const byUnit = naturalCompare(a.unit_reference ?? '', b.unit_reference ?? '')
  if (byUnit !== 0) return byUnit
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ---------------------------------------------------------------------------
// Search + compose
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, trimmed substring match across the property's name,
 * unit reference, address, and its estate label. An empty query matches
 * everything.
 */
export function propertyMatchesQuery(p: FinderProperty, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystacks = [
    p.name,
    p.unit_reference,
    p.address,
    ESTATE_LABEL[classifyEstate(p)],
  ]
  return haystacks.some((h) => (h ?? '').toLowerCase().includes(q))
}

/**
 * Apply the estate filter AND the search query together, then return a
 * new list in natural order. Never mutates the input.
 */
export function filterProperties(
  properties: FinderProperty[],
  opts: { estate: EstateFilter; query: string },
): FinderProperty[] {
  return properties
    .filter((p) => opts.estate === 'all' || classifyEstate(p) === opts.estate)
    .filter((p) => propertyMatchesQuery(p, opts.query))
    .sort(compareProperties)
}

/** Counts per estate plus the total, for the filter tiles. */
export type EstateCounts = Record<EstateFilter, number>

export function estateCounts(properties: FinderProperty[]): EstateCounts {
  const counts: EstateCounts = {
    all: properties.length,
    ballito_life: 0,
    ballito_village: 0,
    other: 0,
  }
  for (const p of properties) counts[classifyEstate(p)] += 1
  return counts
}
