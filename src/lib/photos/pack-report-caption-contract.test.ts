import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SOURCE CONTRACT — pack report caption wiring (P0, Unit 377, 21 Oct 2026).
 *
 * The incident's UI failure mode was STRUCTURAL: one independent
 * updatePhotoNote form per photo plus separate PackSubmitButtons, letting a
 * submit finalise the pack while typed captions sat only in the DOM. This
 * file pins the corrected wiring so that exact layout cannot quietly return.
 *
 * ASSERTION DISCIPLINE (review, 22 Oct): every check here targets EXECUTABLE
 * structure — imports, JSX attributes, function-scoped bodies, call
 * signatures. Comments explaining what was removed must never fail a test,
 * and unrelated functions later in a file must never pollute a scoped check.
 * (The behavioural guarantees live in caption-drafts / caption-autosave /
 * caption-queue-note / capture-note-shadow tests and the SQL suite.)
 */

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

/** Remove // line comments, block comments and JSX comment wrappers so
 *  assertions only ever see executable source. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // JSX {/* ... */}
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (not https://)
}

/** The body of ONE exported async function: from its declaration to the next
 *  top-level export declaration (function/type/const), never end-of-file. */
function exportedFnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`)
  expect(start, `export async function ${name} must exist`).toBeGreaterThan(-1)
  const rest = src.slice(start + 10)
  const next = rest.search(/export (async function|function|type|const) /)
  return src.slice(start, next === -1 ? src.length : start + 10 + next)
}

const reportPage = read('src/app/properties/[id]/packs/[packId]/report/page.tsx')
const packActions = read('src/app/properties/[id]/packs/actions.ts')
const propertyPage = read('src/app/properties/[id]/page.tsx')
const submitButtonFile = read('src/components/photos/pack-submit-button.tsx')
const migration = read('supabase/migrations/20261022090000_caption_durability.sql')

const reportCode = stripComments(reportPage)
const propertyCode = stripComments(propertyPage)
const submitButtonCode = stripComments(submitButtonFile)

describe('pack report page — caption editor wiring', () => {
  it('updatePhotoNote is neither imported nor used as a form action (the incident layout)', () => {
    expect(reportCode).not.toMatch(/import\s*\{[^}]*updatePhotoNote[^}]*\}/)
    expect(reportCode).not.toContain('action={updatePhotoNote}')
  })

  it('no executable per-photo "Save caption" control renders', () => {
    // Comments explaining the removal are allowed (stripped), and the ONE
    // combined control says "Save captionS and submit pack" — only the old
    // singular per-photo button label is banned from executable source.
    expect(reportCode).not.toMatch(/Save caption(?!s)/)
  })

  it('drafts are wrapped in the caption provider with per-photo fields and ONE save-and-submit control', () => {
    expect(reportCode).toContain('PackCaptionProvider')
    expect(reportCode).toContain('<PackCaptionField photoId={photo.id} />')
    expect(reportCode).toContain('<PackCaptionSubmit')
    // Provider wraps ONLY drafts; submitted packs stay a plain immutable record.
    const guard = reportCode.indexOf('if (!isDraft) {')
    const submittedEnd = reportCode.indexOf('\n  }', guard)
    const submittedBranch = reportCode.slice(guard, submittedEnd)
    const provider = reportCode.indexOf('<PackCaptionProvider', submittedEnd)
    expect(guard).toBeGreaterThan(-1)
    expect(provider).toBeGreaterThan(submittedEnd)
    // rev 5: a SUBMITTED pack gets only the read-only device-draft recovery
    // panel — no editor, no provider, no submit.
    expect(submittedBranch).toContain('<SubmittedCaptionRecovery packId={pack.id} serverNotes={serverNotes} />')
    expect(submittedBranch).not.toContain('PackCaptionProvider')
    expect(submittedBranch).not.toContain('PackCaptionSubmit')
  })

  it('the editor seeds from the server-confirmed captions', () => {
    expect(reportCode).toContain('photoRows.map((p) => [p.id, p.notes])')
  })
})

describe('REV 6 BLOCKER 2 — the pack report exposes NO per-photo removal', () => {
  // The pre-arrival pack guard refuses soft-deleting a pack photo, so a
  // removal control here could only ever fail. It must not come back.
  it('softDeleteEvidencePhoto is neither imported nor wired as a form action', () => {
    expect(reportCode).not.toContain('softDeleteEvidencePhoto')
    expect(reportCode).not.toMatch(/import\s*\{[^}]*softDelete[^}]*\}/)
  })

  it('no executable "Remove this photo" control or photo_id removal form remains', () => {
    expect(reportCode).not.toMatch(/Remove this photo/i)
    expect(reportCode).not.toContain('name="photo_id"')
    expect(reportCode).not.toContain('Trash2')
  })

  it('the draft banner no longer tells inspectors to remove photos', () => {
    const banner = reportCode.slice(
      reportCode.indexOf('This pack is still a draft.'),
      reportCode.indexOf('</p>', reportCode.indexOf('This pack is still a draft.')),
    )
    expect(banner).not.toMatch(/remove photos that/i)
    expect(banner).toContain('discard the draft')
  })

  it('the database guard that makes removal impossible is unchanged', () => {
    const guard = read('supabase/migrations/20260718120000_prearrival_photo_intents.sql')
    expect(guard).toContain(
      "'pre-arrival pack photos cannot be removed directly — discard the pack instead'",
    )
    // ...and the caption migration does not redefine (weaken) that guard.
    expect(migration).not.toMatch(/create or replace function public\.photos_prearrival_pack_guard/)
  })
})

describe('save-and-submit server action — ordering + fail-closed shape', () => {
  // Scoped EXACTLY to this function: ends at the next top-level export, so
  // unrelated later actions (e.g. discard's audit insert) cannot pollute it.
  const submitBody = stripComments(exportedFnBody(packActions, 'submitPackWithCaptionsAction'))

  it('finalises ONLY through the single caption transaction RPC', () => {
    expect(submitBody).toMatch(/rpc\(\s*'submit_prearrival_pack_with_captions'/)
    expect(submitBody).not.toMatch(/rpc\(\s*'finalize_prearrival_pack'/)
  })

  it('the RPC call carries p_pack_id + p_captions and NO client company_id', () => {
    const callStart = submitBody.search(/rpc\(\s*'submit_prearrival_pack_with_captions'/)
    const callArgs = submitBody.slice(callStart, submitBody.indexOf(')', callStart + 60) + 1)
    expect(callArgs).toContain('p_pack_id')
    expect(callArgs).toContain('p_captions')
    expect(callArgs).not.toContain('company_id')
    // The whole function never forwards a client-supplied company/status.
    expect(submitBody).not.toContain('company_id:')
    expect(submitBody).not.toContain("status:")
  })

  it('every failure path returns ok:false and says the pack is still a draft', () => {
    expect(submitBody).toContain('ok: false')
    expect(submitBody).toContain('still a draft')
    // caption_conflict is a typed FAILURE (drafts preserved), never success.
    const conflictIdx = submitBody.indexOf("'caption_conflict'")
    expect(conflictIdx).toBeGreaterThan(-1)
    expect(submitBody.slice(conflictIdx - 400, conflictIdx)).not.toContain('ok: true')
  })

  it('the caption autosave action wires the database compare-and-set — with NO bypass flag', () => {
    const saveBody = stripComments(exportedFnBody(packActions, 'saveDraftPhotoCaptionAction'))
    expect(saveBody).toMatch(/rpc\(\s*'set_prearrival_photo_caption'/)
    expect(saveBody).toContain('p_expected_notes')
    // rev 4: the expectation is mandatory; no client flag can disable CAS.
    expect(saveBody).not.toContain('p_expected_known')
    expect(saveBody).not.toContain('expectedKnown')
    expect(saveBody).toContain('safeCaptionError')
  })

  it('the migration exposes ONLY the 3-argument always-CAS autosave', () => {
    expect(migration).toMatch(
      /create or replace function public\.set_prearrival_photo_caption\(\s*p_photo_id\s+uuid,\s*p_note\s+text,\s*p_expected_notes\s+text\s*\)/,
    )
    expect(migration).not.toContain('p_expected_known')
    expect(migration).toContain(
      'drop function if exists public.set_prearrival_photo_caption(uuid, text, text, boolean)',
    )
  })
})

describe('BLOCKER 2 — no user-accessible path bypasses caption review', () => {
  it('pack-submit-button.tsx neither imports nor renders the legacy submit action', () => {
    expect(submitButtonCode).not.toMatch(/import\s*\{[^}]*submitEvidencePackAction[^}]*\}/)
    expect(submitButtonCode).not.toContain('action={submitEvidencePackAction}')
  })

  it('no PackSubmitButton export remains; only status/discard controls do', () => {
    const exports = [...submitButtonCode.matchAll(/export function (\w+)/g)].map((m) => m[1])
    expect(exports).toEqual(['PackStatusBanner', 'DiscardDraftButton'])
  })

  it('the property page uses the "Review captions and submit" link, not a direct submit', () => {
    expect(propertyCode).toContain('Review captions and submit')
    expect(propertyCode).not.toMatch(/import\s*\{[^}]*PackSubmitButton[^}]*\}/)
    expect(propertyCode).not.toContain('<PackSubmitButton')
    expect(propertyCode).not.toContain('submitEvidencePackAction')
  })

  it('the legacy submit action fails closed for pre-arrival and never reaches a finalise call', () => {
    const body = stripComments(exportedFnBody(packActions, 'submitEvidencePackAction'))
    // The pre-arrival refusal exists and no finalize call remains in the action.
    expect(body).toContain("pack.pack_type === 'pre_arrival'")
    expect(body).toContain('Save captions and submit pack')
    expect(body).not.toMatch(/rpc\(\s*'finalize_prearrival_pack'/)
  })

  it('the flag caption action refuses PACK photos (no unaudited caption path)', () => {
    const photosActions = read('src/app/properties/[id]/photos/actions.ts')
    const body = stripComments(exportedFnBody(photosActions, 'updatePhotoNote'))
    expect(body).toContain('evidence_pack_id')
    expect(body).toContain('edited on the pack report')
  })

  it('the migration revokes the direct client grant on finalize_prearrival_pack', () => {
    expect(migration).toContain(
      'revoke execute on function public.finalize_prearrival_pack(uuid) from authenticated',
    )
  })

  it('exactly ONE client call site finalises pre-arrival packs: the caption transaction', () => {
    const count = (stripComments(packActions).match(
      /rpc\(\s*'submit_prearrival_pack_with_captions'/g,
    ) ?? []).length
    expect(count).toBe(1)
    expect(stripComments(packActions)).not.toMatch(/rpc\(\s*'finalize_prearrival_pack'/)
  })
})
