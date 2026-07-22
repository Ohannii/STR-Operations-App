import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SOURCE CONTRACT (P0, 22 Jul evening): the batch attach action must return
 * per-photo results WITHOUT blocking the response on page-regeneration work.
 * revalidatePath inside a Server Action renders the updated page into the
 * SAME response (documented Next.js behaviour) -- that is exactly what
 * delayed batch acknowledgements behind heavy property-page rerenders in the
 * field. Freshness comes from the client's once-per-drain router.refresh()
 * and the routes being dynamic. This test pins the contract at the source
 * level so a future edit cannot quietly reintroduce the coupling.
 */
describe('attachEvidencePhotosBatch response contract', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/properties/[id]/photos/actions.ts'),
    'utf8',
  )

  const start = source.indexOf('export async function attachEvidencePhotosBatch')
  const end = source.indexOf('export async function attachEvidencePhoto(')
  const batchBody = source.slice(start, end)

  it('the batch action exists and precedes the single-photo action', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('successful results reach the client WITHOUT revalidatePath in the response path', () => {
    expect(batchBody).not.toContain('revalidatePath(')
  })

  it('per-item throw isolation and the bounded pool remain in place', () => {
    expect(batchBody).toContain('mapBounded(')
    expect(batchBody).toContain('catch')
  })

  it('the single-photo action KEEPS its revalidatePath calls for its other callers', () => {
    const singleBody = source.slice(end)
    expect(singleBody).toContain('revalidatePath(')
  })
})
