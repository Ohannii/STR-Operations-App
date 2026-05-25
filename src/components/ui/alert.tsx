import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/ui/cn'

type Tone = 'error' | 'success' | 'info'

const TONE: Record<Tone, { wrapper: string; icon: string }> = {
  error: {
    wrapper: 'bg-red-50 border-red-200 text-red-900',
    icon: 'text-red-500',
  },
  success: {
    wrapper: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    icon: 'text-emerald-500',
  },
  info: {
    wrapper: 'bg-blue-50 border-blue-200 text-blue-900',
    icon: 'text-blue-500',
  },
}

const ICON = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
}

export function Alert({
  tone,
  children,
  className,
}: {
  tone: Tone
  children: ReactNode
  className?: string
}) {
  const Icon = ICON[tone]
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 p-3 rounded-md border text-sm',
        TONE[tone].wrapper,
        className,
      )}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon size={16} className={cn('mt-0.5 shrink-0', TONE[tone].icon)} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
