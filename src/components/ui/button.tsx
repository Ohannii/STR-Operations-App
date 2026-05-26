import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/ui/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950 ' +
    'shadow-sm border border-slate-900 ' +
    'disabled:bg-slate-300 disabled:border-slate-300',
  secondary:
    'bg-white text-slate-900 hover:bg-slate-50 active:bg-slate-100 ' +
    'border border-slate-300 ' +
    'disabled:bg-slate-50 disabled:text-slate-400',
  ghost:
    'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 ' +
    'border border-transparent ' +
    'disabled:text-slate-400',
  destructive:
    'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 ' +
    'shadow-sm border border-red-600 ' +
    'disabled:bg-slate-300 disabled:border-slate-300',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
}

/**
 * Returns just the className string. Useful when you need to style
 * a Next.js <Link> like a button without nesting an HTML <button>
 * inside an <a>.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
) {
  return cn(
    'inline-flex items-center justify-center font-medium rounded-md',
    'transition-colors focus-visible:outline-none focus-visible:ring-2',
    'focus-visible:ring-slate-900 focus-visible:ring-offset-2',
    'disabled:cursor-not-allowed',
    VARIANT[variant],
    SIZE[size],
    className,
  )
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonClasses(variant, size, cn(fullWidth && 'w-full', className))}
      {...props}
    >
      {children}
    </button>
  )
}
