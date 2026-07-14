// TEMPORARY performance diagnostics (Slice 11a-perf).
// Logs per-phase server timings to the console (visible in Vercel logs
// under the "[perf]" prefix). Remove once we've measured where the
// time goes — this file and its call sites are diagnostics only.
export function startPerf(route: string) {
  const start = performance.now()
  let last = start
  const marks: string[] = []
  return {
    mark(label: string) {
      const now = performance.now()
      marks.push(`${label}=${(now - last).toFixed(0)}ms`)
      last = now
    },
    done() {
      marks.push(`TOTAL=${(performance.now() - start).toFixed(0)}ms`)
      console.log(`[perf][${route}] ${marks.join(' ')}`)
    },
  }
}
