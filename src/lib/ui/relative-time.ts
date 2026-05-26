/**
 * Renders a date as a short "X minutes ago" / "yesterday" / dated
 * string. Server-rendered, no client-side updates. Good enough for
 * flag cards where exact precision isn't important.
 */
export function relativeTime(input: string | Date): string {
  const then = input instanceof Date ? input : new Date(input)
  const now = new Date()
  const diffMs = now.getTime() - then.getTime()
  const diffSec = Math.round(diffMs / 1000)
  const diffMin = Math.round(diffSec / 60)
  const diffHr = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHr / 24)

  if (diffSec < 30) return 'Just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin < 60) return `${diffMin} min ago`
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 7) return `${diffDay} days ago`
  if (diffDay < 30) return `${Math.round(diffDay / 7)} week${diffDay < 14 ? '' : 's'} ago`

  return then.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
