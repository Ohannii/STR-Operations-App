import { describe, it, expect } from 'vitest'
import { buildPackStartRedirect } from '@/lib/packs/start-redirect'

describe('pack-start redirect — the camera must NEVER auto-open', () => {
  it('REGRESSION (P0, 21 Jul 2026): no auto-open instruction survives in any URL', () => {
    // Router refresh and component remount replay whatever the URL carries —
    // a capture_now param here meant the camera reopened over the
    // inspector's work on every refresh. Twice patched, now removed: no
    // redirect this action produces may carry it, with or without returnTo.
    for (const url of [
      buildPackStartRedirect('prop-1', null),
      buildPackStartRedirect('prop-1', '/properties/prop-1'),
      buildPackStartRedirect('prop-1', '/properties/prop-1?open=abc'),
    ]) {
      expect(url).not.toContain('capture_now')
    }
  })

  it('lands on the property page with the started notice', () => {
    expect(buildPackStartRedirect('prop-9', null)).toBe('/properties/prop-9?pack_started=1')
  })

  it('honours a provided safe return target verbatim', () => {
    expect(buildPackStartRedirect('prop-9', '/properties/prop-9?open=x')).toBe(
      '/properties/prop-9?open=x',
    )
  })
})
