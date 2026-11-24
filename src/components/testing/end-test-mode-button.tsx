'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { endTestMode } from '@/app/dashboard/testing/actions'

export function EndTestModeButton() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState('')
  return <span className="flex items-center gap-2">
    {error && <span role="alert" className="text-xs text-rose-800">{error}</span>}
    <button type="button" disabled={pending} onClick={() => start(async () => {
      const result = await endTestMode()
      if (!result.ok) { setError(result.error); return }
      router.refresh()
    })} className="min-h-11 rounded-lg border border-amber-400 bg-white px-3 text-sm font-semibold text-amber-950 hover:bg-amber-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700">
      {pending ? 'Ending…' : 'End test mode'}
    </button>
  </span>
}
