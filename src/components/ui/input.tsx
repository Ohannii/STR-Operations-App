import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/ui/cn'

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('block text-sm font-medium text-slate-700 mb-1.5', className)}
      {...props}
    >
      {children}
    </label>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'block w-full h-10 px-3 text-sm text-slate-900',
        'placeholder:text-slate-400',
        'border border-slate-300 rounded-md bg-white',
        'focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900',
        'disabled:bg-slate-50 disabled:text-slate-500',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Convenience wrapper: label + (auto-generated id wiring is the
 * caller's responsibility) + optional hint text.
 */
export function Field({
  label,
  hint,
  required,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  required?: boolean
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-red-600 ml-0.5">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}
