import Link from 'next/link'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { loadHandoffHealth } from '@/lib/integrations/asana/load-handoff-health'

/** "23 Nov, 14:05" in South Africa time. */
function sast(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(Date.parse(iso) + 2 * 3_600_000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * Asana handoff health for operations managers (the database refuses
 * everyone else). variant 'alert' renders ONLY when something needs
 * attention (dashboard); 'panel' always renders (Testing page).
 */
export async function AsanaHandoffStatus({ companyId, variant }: { companyId: string; variant: 'alert' | 'panel' }) {
  const health = await loadHandoffHealth(await createClient(), companyId)
  if (health === 'unavailable') {
    return variant === 'panel'
      ? <p className="text-sm text-slate-600">The Asana check is not available yet (database update pending) or could not be loaded.</p>
      : null
  }
  if (variant === 'alert' && health.level !== 'attention') return null
  const attention = health.level === 'attention'
  return <section aria-labelledby="asana-health-heading" role={attention ? 'alert' : undefined}
    className={`rounded-xl border p-4 sm:p-5 ${attention ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <h2 id="asana-health-heading" className={`flex items-center gap-2 text-base font-semibold ${attention ? 'text-amber-950' : 'text-slate-900'}`}>
      {attention ? <AlertTriangle size={18} aria-hidden className="shrink-0" /> : <CheckCircle2 size={18} aria-hidden className="shrink-0 text-emerald-700" />}
      {health.headline}
    </h2>
    {health.details.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-950">{health.details.map((d) => <li key={d}>{d}</li>)}</ul>}
    {health.items.length > 0 && <ul className="mt-3 divide-y divide-amber-200 rounded-lg border border-amber-200 bg-white">
      {health.items.map((i) => <li key={i.href}>
        <Link href={i.href} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-amber-50">
          <span className="font-medium text-slate-900">{i.apartment}</span>
          <span className="text-slate-600">{i.label} · reported {sast(i.raisedAt)}</span>
        </Link>
      </li>)}
    </ul>}
    {health.actions.length > 0 && <div className="mt-3 text-sm text-amber-950"><p className="font-semibold">What to do</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">{health.actions.map((a) => <li key={a}>{a}</li>)}</ul></div>}
    {health.level !== 'off' && <p className={`mt-3 text-xs ${attention ? 'text-amber-900' : 'text-slate-500'}`}>
      Automatic check last ran {sast(health.lastCheckAt)}; last successful {sast(health.lastCheckOkAt)}.
    </p>}
  </section>
}
