'use client'

import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'

/**
 * Web Share API button. Renders only when the browser supports
 * navigator.share() — otherwise stays invisible so the
 * print/save-as-PDF affordance is the only fallback (no broken
 * button on desktop browsers without share support).
 *
 * Behaviour:
 *   - On click, calls navigator.share with the current URL +
 *     supplied title + text. On iOS Safari + Chrome on Android
 *     this triggers the native share sheet (WhatsApp / Mail /
 *     etc.). On desktop Chrome it triggers the OS share sheet
 *     where supported.
 *   - If navigator.share rejects (user cancelled or unavailable),
 *     fail silently. The print button is still there.
 */
export function ShareButton({
  title,
  text,
}: {
  title: string
  text?: string
}) {
  const [canShare, setCanShare] = useState(false)

  // One-shot feature detection. Has to live in useEffect because
  // `navigator` is not available during SSR — checking in render
  // produces a hydration mismatch. The React 19
  // react-hooks/set-state-in-effect rule fires for this pattern;
  // here it's the correct shape because we're explicitly
  // synchronising client-only state into React's tree after mount.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCanShare(true)
    }
  }, [])

  if (!canShare) return null

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.share({
            title,
            text,
            url: typeof window !== 'undefined' ? window.location.href : '',
          })
        } catch {
          // User cancelled or share is not actually available
          // (some browsers expose navigator.share but reject when
          // called outside a user gesture). Silent fail is OK.
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
    >
      <Share2 size={14} aria-hidden />
      Share
    </button>
  )
}
