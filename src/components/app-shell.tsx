import Link from 'next/link'
import { Building2, LogOut } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * App shell for logged-in pages. Sticky header with brand + company
 * label on the left, user identity + sign-out on the right. The
 * main content area is constrained to a 6xl column with responsive
 * horizontal padding.
 *
 * Navigation will land here when additional sections ship
 * (Inspections, Reports, Settings). For v1.0 first-screens the
 * header stays minimal because Dashboard is the only top-level page.
 */
export function AppShell({
  companyName,
  userName,
  userEmail,
  children,
}: {
  companyName: string
  userName: string
  userEmail: string
  children: ReactNode
}) {
  return (
    <div className="min-h-screen bg-slate-50 overflow-x-clip">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/90">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 min-w-0 group"
          >
            <div className="w-7 h-7 rounded-md bg-slate-900 flex items-center justify-center shrink-0 group-hover:bg-slate-800 transition-colors">
              <Building2 size={15} className="text-white" />
            </div>
            <div className="min-w-0 hidden xs:block">
              <p className="text-[10px] uppercase tracking-wider text-slate-500 leading-none">
                Company
              </p>
              <p className="text-sm font-semibold text-slate-900 truncate leading-tight">
                {companyName}
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <p className="text-sm font-medium text-slate-900">{userName}</p>
              <p className="text-xs text-slate-500">{userEmail}</p>
            </div>
            <form action="/auth/signout" method="POST">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                aria-label="Sign out"
              >
                <LogOut size={14} aria-hidden />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>
    </div>
  )
}
