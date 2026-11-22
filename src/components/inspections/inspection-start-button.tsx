'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { startTurnover } from '@/app/dashboard/work/actions'

export function InspectionStartButton({ jobId, propertyId, label = 'Start scheduled inspection' }: {
  jobId: string; propertyId: string; label?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState('')
  return <div>
    <button type="button" disabled={pending} className="min-h-12 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40" onClick={() => {
      if (pending) return
      start(async () => {
        setError('')
        const result = await startTurnover(jobId)
        if (!result.ok) { setError(result.error); return }
        router.push(`/properties/${propertyId}`)
        router.refresh()
      })
    }}>{pending ? 'Opening…' : label}</button>
    {error && <p role="alert" className="mt-2 text-sm text-rose-700">{error}</p>}
  </div>
}
