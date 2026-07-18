'use client'

import Link from 'next/link'
import { useId, useMemo, useState } from 'react'
import { Building2, Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/ui/cn'
import { propertyStatusDisplay } from '@/lib/ui/property-status'
import {
  ESTATE_LABEL,
  estateCounts,
  filterProperties,
  type EstateFilter,
  type FinderProperty,
} from '@/lib/properties/finder'

/**
 * Client-side property finder for the dashboard (feat/property-finder-mobile).
 *
 * Operates entirely on the already-authorized, company-scoped property list
 * passed from the server component — no extra fetching, no client-side
 * privilege. All classification / search / sort logic lives in the pure
 * `@/lib/properties/finder` helpers (unit-tested); this is presentation only.
 *
 * Layout is mobile-first and clip-safe: the tile row wraps, every card is a
 * `min-w-0` grid item so long content can shrink instead of forcing the page
 * wider than the viewport, names/addresses truncate, and the status badge is
 * `shrink-0` so labels like "Idle" always stay fully visible.
 */
export function PropertyFinder({ properties }: { properties: FinderProperty[] }) {
  const [estate, setEstate] = useState<EstateFilter>('all')
  const [query, setQuery] = useState('')
  const searchId = useId()

  const counts = useMemo(() => estateCounts(properties), [properties])
  const results = useMemo(
    () => filterProperties(properties, { estate, query }),
    [properties, estate, query],
  )

  const tiles: { key: EstateFilter; label: string }[] = [
    { key: 'all', label: 'All properties' },
    { key: 'ballito_life', label: ESTATE_LABEL.ballito_life },
    { key: 'ballito_village', label: ESTATE_LABEL.ballito_village },
  ]
  // Only surface an "Other" tile when there is actually something in it, so we
  // never hide unmatched / test properties but also don't clutter the UI.
  if (counts.other > 0) tiles.push({ key: 'other', label: ESTATE_LABEL.other })

  const hasQuery = query.trim().length > 0
  const clearAll = () => {
    setEstate('all')
    setQuery('')
  }

  return (
    <div className="min-w-0">
      {/* Estate filter tiles */}
      <div
        role="group"
        aria-label="Filter properties by estate"
        className="flex flex-wrap gap-2 mb-3"
      >
        {tiles.map((t) => {
          const active = estate === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setEstate(t.key)}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium',
                'transition-colors select-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2',
                active
                  ? 'bg-slate-900 border-slate-900 text-white'
                  : 'bg-white border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50',
              )}
            >
              <span>{t.label}</span>
              <span
                className={cn(
                  'inline-flex items-center justify-center min-w-[1.25rem] px-1 rounded-md text-xs tabular-nums',
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600',
                )}
              >
                {counts[t.key]}
              </span>
            </button>
          )
        })}
      </div>

      {/* Quick find */}
      <div className="mb-5">
        <label htmlFor={searchId} className="sr-only">
          Quick find a property
        </label>
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            inputMode="search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Quick find — name, unit, address or estate"
            className={cn(
              'block w-full h-11 pl-9 pr-10 text-sm text-slate-900 placeholder:text-slate-400',
              'border border-slate-300 rounded-lg bg-white',
              'focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900',
            )}
          />
          {hasQuery ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              <X size={16} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {/* Results */}
      {results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <Building2 size={20} className="mx-auto text-slate-400" aria-hidden />
          <p className="mt-2 text-sm font-medium text-slate-900">No matching properties</p>
          <p className="mt-1 text-sm text-slate-600">
            {hasQuery
              ? `Nothing matches your search${estate !== 'all' ? ' in this estate' : ''}.`
              : 'No properties in this estate yet.'}
          </p>
          <button
            type="button"
            onClick={clearAll}
            className="mt-4 inline-flex items-center text-sm font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 rounded"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {results.length} propert{results.length === 1 ? 'y' : 'ies'} shown
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((p) => {
              const status = propertyStatusDisplay(p.status)
              const sub = [p.unit_reference, p.address].filter(Boolean).join(' · ')
              return (
                <Link
                  key={p.id}
                  href={`/properties/${p.id}`}
                  className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
                  aria-label={`Open ${p.name}`}
                >
                  <Card className="h-full hover:border-slate-300 hover:shadow transition-all">
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">{p.name}</h3>
                          {sub ? (
                            <p className="text-sm text-slate-600 mt-0.5 truncate">{sub}</p>
                          ) : (
                            <p className="text-sm text-slate-400 mt-0.5 italic">No address</p>
                          )}
                        </div>
                        <Badge tone={status.tone} className="shrink-0">
                          {status.label}
                        </Badge>
                      </div>
                      <dl className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                        <div className="min-w-0">
                          <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                            Bedrooms
                          </dt>
                          <dd className="text-sm font-medium text-slate-900 mt-0.5">
                            {p.bedrooms ?? '—'}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                            Last inspection
                          </dt>
                          <dd className="text-sm font-medium text-slate-500 mt-0.5">Never</dd>
                        </div>
                      </dl>
                    </div>
                  </Card>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
