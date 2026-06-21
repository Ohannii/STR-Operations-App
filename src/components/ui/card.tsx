import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/ui/cn'

/**
 * Plain content surface. White background, subtle border + shadow.
 * Default rounded-xl matches the rest of the design system.
 */
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // min-w-0 so a Card used as a grid/flex item can shrink below its
        // content's intrinsic width (grid items default to min-width:auto,
        // which otherwise forces the track — and the page — wider than the
        // viewport on mobile). w-full keeps it filling its container.
        'w-full min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-5 py-4 border-b border-slate-200', className)} {...props} />
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'px-5 py-3 border-t border-slate-200 bg-slate-50/50 rounded-b-xl',
        className,
      )}
      {...props}
    />
  )
}
