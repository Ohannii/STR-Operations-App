import { cn } from '@/lib/ui/cn'

export type ChipTone = 'slate' | 'red' | 'amber' | 'sky' | 'blue' | 'emerald' | 'orange'

// Color applied to the chip when the underlying radio is checked.
// Kept consistent with Badge tones but rendered solid for visibility.
const CHECKED_TONE: Record<ChipTone, string> = {
  slate:
    'peer-checked:bg-slate-900 peer-checked:border-slate-900 peer-checked:text-white',
  red:
    'peer-checked:bg-red-600 peer-checked:border-red-600 peer-checked:text-white',
  amber:
    'peer-checked:bg-amber-500 peer-checked:border-amber-500 peer-checked:text-white',
  sky:
    'peer-checked:bg-sky-600 peer-checked:border-sky-600 peer-checked:text-white',
  blue:
    'peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-checked:text-white',
  emerald:
    'peer-checked:bg-emerald-600 peer-checked:border-emerald-600 peer-checked:text-white',
  orange:
    'peer-checked:bg-orange-600 peer-checked:border-orange-600 peer-checked:text-white',
}

/**
 * Radio-input rendered as a styled pill. The native radio is
 * visually hidden but still drives keyboard + a11y semantics.
 * Used for status / severity / responsibility pickers where the
 * options fit on a single row and a dropdown would feel heavy.
 */
export function RadioChip({
  name,
  value,
  label,
  defaultChecked,
  tone = 'slate',
  disabled,
}: {
  name: string
  value: string
  label: string
  defaultChecked?: boolean
  tone?: ChipTone
  disabled?: boolean
}) {
  return (
    <label className={cn('cursor-pointer select-none', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        className={cn(
          'inline-block px-3 py-1.5 text-sm font-medium rounded-md border',
          'border-slate-300 bg-white text-slate-700',
          'hover:border-slate-400 transition-colors',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900 peer-focus-visible:ring-offset-2',
          CHECKED_TONE[tone],
        )}
      >
        {label}
      </span>
    </label>
  )
}
