'use client'

import type { ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { buttonClasses, type ButtonSize, type ButtonVariant } from '@/components/ui/button'

/**
 * Submit button that disables itself and shows a pending label while the
 * form's server action is in flight.
 *
 * Why: on a slow connection, testers tapped "Report issue" more than once
 * because submission took a moment, creating duplicate issues. Disabling
 * the button while pending (and changing the label) prevents accidental
 * repeated submits without any heavy duplicate-detection logic.
 *
 * Must be rendered INSIDE the <form> it submits — useFormStatus() reads
 * the pending state of the nearest parent form's action.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Working…',
  variant = 'primary',
  size = 'md',
  fullWidth = false,
}: {
  children: ReactNode
  pendingLabel?: string
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={buttonClasses(variant, size, fullWidth ? 'w-full' : undefined)}
    >
      {pending ? (
        <>
          <Loader2 size={16} className="animate-spin" aria-hidden />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}
