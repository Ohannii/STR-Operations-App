import type { ReactNode } from 'react'
import { cn } from '@/lib/ui/cn'

export type BadgeTone = 'slate' | 'blue' | 'amber' | 'orange' | 'red' | 'emerald' | 'sky'

const TONE: Record<BadgeTone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
}

/**
 * Status pill. `tone` decides color; default = slate (neutral).
 * Use the property-status helper to translate raw DB status values.
 */
export function Badge({
  tone = 'slate',
  children,
  className,
}: {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md',
        'text-[10px] font-semibold uppercase tracking-wider',
        'ring-1 ring-inset',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
