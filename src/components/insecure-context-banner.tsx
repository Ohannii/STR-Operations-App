'use client'

/**
 * InsecureContextBanner — surfaces a clear warning when the app
 * is loaded over plain HTTP (typically `http://192.168.x.x:3000`
 * during local LAN testing).
 *
 * Why this matters:
 *   - iPhone Safari blocks `getUserMedia()` outside a secure
 *     context — no in-app camera over LAN HTTP, period.
 *   - iPhone Safari surfaces a "this information is not secure"
 *     popup before every form submission (server actions land
 *     here). The user has to confirm "Send anyway" or the action
 *     never reaches the server.
 *   - These are browser security guarantees we can't engineer
 *     around. The right answer is to test over HTTPS (Cloudflare
 *     Tunnel works well: see docs/MOBILE_TESTING.md).
 *
 * The banner only renders client-side (window.isSecureContext is
 * unavailable during SSR). The check happens in useEffect to
 * avoid a hydration mismatch.
 *
 * Local `localhost:3000` IS a secure context per the spec, so
 * desktop dev doesn't see this banner. Only LAN-IP / cross-host
 * loads trigger it.
 */

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'

export function InsecureContextBanner() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    // window.isSecureContext is true for localhost, *.localhost,
    // 127.x.x.x, and any HTTPS origin. It's false for plain HTTP
    // on a LAN IP — exactly the case where iOS blocks features.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!window.isSecureContext) setShow(true)
  }, [])

  if (!show) return null

  return (
    <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <ShieldAlert
        size={16}
        className="text-amber-700 mt-0.5 shrink-0"
        aria-hidden
      />
      <div className="min-w-0 text-sm text-amber-900 leading-relaxed">
        <p className="font-semibold">Testing over an insecure connection.</p>
        <p className="mt-0.5">
          On iPhone / iPad Safari, this means: in-app camera (Take
          photos) won&rsquo;t open and form submissions (Submit,
          Discard, etc.) trigger a &ldquo;not secure&rdquo; popup.
          Use a Cloudflare Tunnel HTTPS URL for proper mobile
          testing &mdash; see <span className="font-medium">docs/MOBILE_TESTING.md</span>.
        </p>
        <p className="mt-1 text-xs text-amber-800">
          Upload from gallery should still work; if it doesn&rsquo;t,
          the per-file error rows under the button will show the
          exact failure.
        </p>
      </div>
    </div>
  )
}
