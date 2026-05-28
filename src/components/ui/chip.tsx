import { Check, type LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
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

// ============================================================
// ToggleChip — used by the operational-marks system (Session 6).
// ============================================================
//
// Renders as an HTML <button>, intended to live inside a single-button
// <form> that posts to a server action. The visual treatment:
//   - INACTIVE (chip not set): outlined, slate text, mobile-friendly
//     touch target, low visual weight.
//   - ACTIVE (chip is set on the flag): solid color matching the
//     chip's semantic tone, white text, small Check icon.
//
// Click toggles state via the server action; this component does not
// manage state itself.

const TOGGLE_ACTIVE_TONE: Record<ChipTone, string> = {
  slate:   'bg-slate-900 border-slate-900 text-white',
  red:     'bg-red-600 border-red-600 text-white',
  amber:   'bg-amber-500 border-amber-500 text-white',
  sky:     'bg-sky-600 border-sky-600 text-white',
  blue:    'bg-blue-600 border-blue-600 text-white',
  emerald: 'bg-emerald-600 border-emerald-600 text-white',
  orange:  'bg-orange-600 border-orange-600 text-white',
}

export interface ToggleChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean
  label: string
  tone?: ChipTone
  icon?: LucideIcon
}

export function ToggleChip({
  active,
  label,
  tone = 'slate',
  icon: Icon,
  className,
  ...rest
}: ToggleChipProps) {
  return (
    <button
      type="submit"
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 h-9 rounded-md text-sm font-medium',
        'border transition-colors select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? TOGGLE_ACTIVE_TONE[tone]
          : 'bg-white border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50',
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon size={14} aria-hidden /> : null}
      <span>{label}</span>
      {active ? <Check size={12} aria-hidden /> : null}
    </button>
  )
}

// ============================================================
// StaticChip — read-only chip badge for compact rendering inside
// flag cards on the Action Centre. No click, no form.
// ============================================================

export function StaticChip({
  label,
  tone = 'slate',
  icon: Icon,
  className,
}: {
  label: string
  tone?: ChipTone
  icon?: LucideIcon
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium',
        TOGGLE_ACTIVE_TONE[tone],
        className,
      )}
    >
      {Icon ? <Icon size={10} aria-hidden /> : null}
      {label}
    </span>
  )
}
