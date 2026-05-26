import Link from 'next/link'
import { Building2 } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Centered container used by the unauthenticated and onboarding
 * flows (/login, /signup, /onboard). Provides a consistent header
 * brand mark, card surface, and footer micro-text.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="flex items-center gap-2 mb-6 justify-center text-slate-900"
          >
            <div className="w-9 h-9 rounded-lg bg-slate-900 flex items-center justify-center">
              <Building2 size={18} className="text-white" />
            </div>
            <span className="font-semibold tracking-tight">STR Operations</span>
          </Link>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 sm:p-8">
            <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1.5 text-sm text-slate-600">{subtitle}</p>
            ) : null}
            <div className="mt-6">{children}</div>
          </div>

          {footer ? (
            <div className="mt-4 text-center text-sm text-slate-600">{footer}</div>
          ) : null}
        </div>
      </div>
      <footer className="py-4 text-center text-xs text-slate-400">
        STR Operations · v1.0 build · staging
      </footer>
    </div>
  )
}
