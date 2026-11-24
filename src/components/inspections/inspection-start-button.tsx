'use client'

import { useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Camera } from 'lucide-react'
import { startTurnover } from '@/app/dashboard/work/actions'

export function InspectionStartButton({ jobId, propertyId, label = 'Start scheduled inspection' }: {
  jobId: string; propertyId: string; label?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState('')
  const errorId = useId()
  const starting = useRef(false)
  return <div>
    <button type="button" disabled={pending} aria-busy={pending} aria-describedby={error ? errorId : undefined} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2 disabled:opacity-40 sm:w-auto" onClick={() => {
      if (starting.current) return
      if (!navigator.onLine) { setError('No connection. Reconnect, then try again.'); return }
      starting.current = true
      start(async () => {
        setError('')
        try {
          const result = await startTurnover(jobId)
          if (!result.ok) { setError(result.error); return }
          router.push(`/properties/${propertyId}`)
          router.refresh()
        } catch {
          // A response can be lost AFTER the server saved. Never promise that
          // nothing started; the guarded action reopens this same visit on retry.
          setError('Could not confirm the inspection opened. Check your connection, then try again. Retrying opens the same inspection.')
        } finally { starting.current = false }
      })
    }}><Camera size={18} aria-hidden />{pending ? 'Opening…' : label}</button>
    {error && <p id={errorId} role="alert" className="mt-2 text-sm text-rose-700">{error}</p>}
  </div>
}
