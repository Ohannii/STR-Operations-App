'use client'

import { Printer } from 'lucide-react'

/**
 * Client-only print trigger. Lives in its own file so the report
 * page itself stays a server component (no client boundary cost
 * for the bulk of the rendering).
 *
 * window.print() saves as PDF on every modern desktop browser via
 * the print dialog's "Save as PDF" destination. On iOS Safari the
 * Share sheet's "Print" option produces a PDF preview that can be
 * saved or sent to WhatsApp. No PDF library required.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== 'undefined') {
          window.print()
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 text-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-800 active:bg-slate-950 transition"
    >
      <Printer size={14} aria-hidden />
      Print / Save as PDF
    </button>
  )
}
