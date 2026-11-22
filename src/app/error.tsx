'use client'

/** Unexpected rendering failures must still offer a safe way back to server truth. */
export default function AppError() {
  return <main className="mx-auto flex min-h-[70dvh] max-w-md flex-col justify-center px-5 py-8">
    <p className="text-sm font-semibold text-teal-800">STR Operations</p>
    <h1 className="mt-3 text-2xl font-semibold text-slate-900">Could not load this screen</h1>
    <p className="mt-3 text-base leading-relaxed text-slate-700">Check your connection, then reload. If you just started or submitted an inspection, check its latest status before starting another.</p>
    <button type="button" onClick={() => window.location.reload()} className="mt-6 min-h-12 rounded-xl bg-teal-700 px-4 py-3 font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 focus-visible:ring-offset-2">Reload</button>
  </main>
}
