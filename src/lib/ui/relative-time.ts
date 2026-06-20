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
    // Pin to SAST so the server (UTC) and client agree and the date
    // matches the team's wall clock. See @/lib/ui/datetime.
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Renders a FUTURE date as "in X" / "overdue by Y". Used for
 * deadlines (e.g. guest recovery task deadline_at).
 */
export function relativeTimeUntil(input: string | Date): string {
  const then = input instanceof Date ? input : new Date(input)
  const now = new Date()
  const diffMs = then.getTime() - now.getTime()

  if (diffMs < 0) {
    const overdueMs = -diffMs
    const overdueMin = Math.round(overdueMs / 60000)
    const overdueHr = Math.round(overdueMin / 60)
    const overdueDay = Math.round(overdueHr / 24)
    if (overdueMin < 60) return `Overdue by ${overdueMin} min`
    if (overdueHr < 24) return `Overdue by ${overdueHr} hour${overdueHr === 1 ? '' : 's'}`
    return `Overdue by ${overdueDay} day${overdueDay === 1 ? '' : 's'}`
  }

  const min = Math.round(diffMs / 60000)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)

  if (min < 1) return 'Now'
  if (min < 60) return `In ${min} min`
  if (hr < 24) return `In ${hr} hour${hr === 1 ? '' : 's'}`
  return `In ${day} day${day === 1 ? '' : 's'}`
}
