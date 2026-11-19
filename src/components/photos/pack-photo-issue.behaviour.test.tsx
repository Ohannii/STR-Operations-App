import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ISSUE_DESCRIPTION_MAX,
  ISSUE_SAVE_FAILED,
  initialIssueSheetState,
  issueSheetBlocker,
  issueSheetReducer,
  runIssueSave,
  type IssueSaveDeps,
  type IssueSheetAction,
  type IssueSheetState,
} from '@/lib/issues/issue-sheet-state'
import { PackPhotoIssueForm } from '@/components/photos/pack-photo-issue-form'

/**
 * "Report issue" sheet behaviour.
 *
 * The repo has no DOM test environment (Vitest runs in node; no jsdom /
 * testing-library dependency), so the sheet is built as a pure state
 * machine + a pure view, and both halves are tested for real:
 *   - the state machine + save flow, driven with DEFERRED server responses
 *     through the exact reducer / runIssueSave the sheet uses;
 *   - the form view, rendered with react-dom/server from those states.
 */

vi.mock('@/components/photos/pack-caption-editor', () => ({
  usePackPhotoCaption: () => ({ caption: 'Chipped bowl on the counter', packSubmitting: false }),
}))

const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const PACK_PHOTO = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'
const IDS = { flagId: '96487471-8c6e-48bc-828e-26255ad5277d', photoId: 'c5b1a2e4-1f7d-4c2b-9a8e-3d6f5e4c2b1a' }
const PHOTO = { photoId: IDS.photoId, width: 1600, height: 1200, sizeBytes: 345678 }
const CTX = { propertyId: PROP, packPhotoId: PACK_PHOTO, ids: IDS }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** The same synchronous store the sheet component uses (ref + reducer). */
function store(initial: IssueSheetState) {
  let state = initial
  return {
    get: () => state,
    dispatch: (a: IssueSheetAction) => {
      state = issueSheetReducer(state, a)
    },
  }
}

type PrepareResult = Awaited<ReturnType<IssueSaveDeps['prepare']>>
type FinalizeResult = Awaited<ReturnType<IssueSaveDeps['finalize']>>

/** A filled-in form: Inventory / Missing item / Fix. */
function filled(caption = 'Chipped bowl on the counter') {
  const s = store(initialIssueSheetState(caption))
  s.dispatch({ type: 'issueType', key: 'inventory_missing', defaultPriority: 'med' })
  s.dispatch({ type: 'toggleAction', value: 'fix' })
  return s
}

const EVERY_EDIT: IssueSheetAction[] = [
  { type: 'issueType', key: 'maintenance_issue', defaultPriority: 'high' },
  { type: 'priority', value: 'high' },
  { type: 'description', value: 'typed while saving' },
  { type: 'category', value: 'maintenance' },
  { type: 'incidentType', value: 'lost_keys' },
  { type: 'toggleAction', value: 'replace' },
  { type: 'severity', value: 'major' },
  { type: 'fixOwner', value: 'vendor' },
  { type: 'toggleMore' },
  { type: 'invalid', error: 'x' },
]

describe('the form is FROZEN while a save runs (deferred server responses)', () => {
  it('REPRO: changing Category (and everything else) while the photo is being prepared changes NOTHING; what was on screen is what is saved', async () => {
    const s = filled()
    const prep = deferred<PrepareResult>()
    const fin = deferred<FinalizeResult>()
    const deps = { prepare: vi.fn(() => prep.promise), finalize: vi.fn(() => fin.promise) }

    const saving = runIssueSave(deps, CTX, s.get, s.dispatch)
    expect(s.get().saving).toBe(true)
    const atTap = s.get()

    // ...photo preparation is pending: the reporter tries to edit.
    for (const edit of EVERY_EDIT) s.dispatch(edit)
    expect(s.get()).toBe(atTap) // identical object: not one field changed

    prep.resolve({ ok: true, photo: PHOTO })
    await Promise.resolve()
    await Promise.resolve()
    // ...finalisation is pending: still frozen.
    for (const edit of EVERY_EDIT) s.dispatch(edit)
    expect(s.get().selections).toEqual({ category: 'inventory', incidentType: 'missing_item', actions: ['fix'], severity: null, fixOwner: null })
    expect(s.get().description).toBe('Chipped bowl on the counter')

    fin.resolve({ ok: true, flagId: IDS.flagId, asanaStatus: 'queued' })
    expect(await saving).toEqual({ ok: true, flagId: IDS.flagId, asanaStatus: 'queued' })

    expect(deps.finalize).toHaveBeenCalledTimes(1)
    expect((deps.finalize.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      proposedFlagId: IDS.flagId,
      categoryKey: 'inventory_missing',
      severity: 'med',
      description: 'Chipped bowl on the counter',
      photos: [PHOTO],
      issue: {
        sourcePackPhotoId: PACK_PHOTO,
        selections: { category: 'inventory', incidentType: 'missing_item', actions: ['fix'], severity: null, fixOwner: null },
      },
    })
    // No newer input existed to be cleared: the state at success IS what was saved.
    expect(s.get().selections.category).toBe('inventory')
  })

  it('the rendered form disables EVERY field, Cancel and Save while saving — and enables them otherwise', () => {
    const render = (state: IssueSheetState) =>
      renderToStaticMarkup(
        <PackPhotoIssueForm
          fieldId="f"
          state={state}
          dispatch={() => {}}
          issueTypes={[{ key: 'inventory_missing', label: 'Item missing', severityDefault: 'med' }]}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      )
    const idle = filled().get()
    const busy = issueSheetReducer(idle, { type: 'saveStarted' })

    const busyHtml = render(busy)
    // one disabled fieldset wraps every input / select / textarea / chip
    expect(busyHtml).toMatch(/<form[^>]*aria-busy="true"[^>]*><fieldset disabled=""/)
    const insideFieldset = busyHtml.slice(busyHtml.indexOf('<fieldset disabled=""'), busyHtml.lastIndexOf('</fieldset>'))
    for (const control of ['<select', '<textarea', 'type="radio"', 'type="checkbox"', 'aria-controls="f-more"']) {
      expect(insideFieldset).toContain(control)
    }
    const afterFieldset = busyHtml.slice(busyHtml.lastIndexOf('</fieldset>'))
    expect(afterFieldset.match(/<button[^>]*disabled=""/g)).toHaveLength(2) // Cancel + Save
    expect(afterFieldset).toContain('Saving issue…')
    expect((busyHtml.match(/<(input|select|textarea)/g) ?? []).length).toBeGreaterThan(15)

    const idleHtml = render(idle)
    expect(idleHtml).not.toContain('disabled=""><div') // fieldset not disabled
    expect(idleHtml).not.toMatch(/<fieldset disabled/)
    expect(idleHtml.slice(idleHtml.lastIndexOf('</fieldset>'))).not.toContain('disabled=""')
    expect(idleHtml).toContain('Save issue')
  })
})

describe('a FAILED save restores editing with every value kept', () => {
  it('finalise fails (deferred) -> error shown, values + prepared photo kept, editing works again; the retry reuses the SAME ids and does not re-copy the photo', async () => {
    const s = filled()
    s.dispatch({ type: 'severity', value: 'major' })
    const fin = deferred<FinalizeResult>()
    const deps = {
      prepare: vi.fn(async (): Promise<PrepareResult> => ({ ok: true, photo: PHOTO })),
      finalize: vi.fn((): Promise<FinalizeResult> => fin.promise),
    }
    const before = s.get()
    const attempt = runIssueSave(deps, CTX, s.get, s.dispatch)
    fin.resolve({ ok: false, error: 'Could not save the issue. Try again.' })
    expect(await attempt).toEqual({ ok: false })

    expect(s.get()).toEqual({ ...before, saving: false, error: 'Could not save the issue. Try again.', prepared: PHOTO })

    // editing is restored
    s.dispatch({ type: 'category', value: 'maintenance' })
    expect(s.get().selections.category).toBe('maintenance')

    // retry: same issue id, photo not prepared twice
    deps.finalize.mockImplementationOnce(async () => ({ ok: true, flagId: IDS.flagId, asanaStatus: 'queued' }))
    expect(await runIssueSave(deps, CTX, s.get, s.dispatch)).toMatchObject({ ok: true })
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.finalize.mock.calls.map((c) => (c as unknown as [{ proposedFlagId: string }])[0].proposedFlagId)).toEqual([IDS.flagId, IDS.flagId])
    expect((deps.finalize.mock.calls[1] as unknown as [{ issue: { selections: { category: string } } }])[0].issue.selections.category).toBe('maintenance')
  })

  it('photo preparation fails -> its message, values kept, finalise never called', async () => {
    const s = filled()
    const deps = {
      prepare: vi.fn(async (): Promise<PrepareResult> => ({ ok: false, error: 'Could not attach the pack photo. Try again.' })),
      finalize: vi.fn(),
    }
    const before = s.get()
    expect(await runIssueSave(deps as unknown as IssueSaveDeps, CTX, s.get, s.dispatch)).toEqual({ ok: false })
    expect(s.get()).toEqual({ ...before, error: 'Could not attach the pack photo. Try again.' })
    expect(deps.finalize).not.toHaveBeenCalled()
  })

  it('a thrown error (connection lost) -> generic message, values kept, editing restored', async () => {
    const s = filled()
    const prep = deferred<PrepareResult>()
    const deps = { prepare: vi.fn(() => prep.promise), finalize: vi.fn() }
    const attempt = runIssueSave(deps as unknown as IssueSaveDeps, CTX, s.get, s.dispatch)
    prep.reject(new TypeError('Failed to fetch'))
    expect(await attempt).toEqual({ ok: false })
    expect(s.get()).toMatchObject({ saving: false, error: ISSUE_SAVE_FAILED, issueType: 'inventory_missing', description: 'Chipped bowl on the counter' })
  })
})

describe('single flight + validation', () => {
  it('repeated taps while saving make ONE prepare and ONE finalise call', async () => {
    const s = filled()
    const prep = deferred<PrepareResult>()
    const deps = {
      prepare: vi.fn(() => prep.promise),
      finalize: vi.fn(async (): Promise<FinalizeResult> => ({ ok: true, flagId: IDS.flagId, asanaStatus: 'queued' })),
    }
    const first = runIssueSave(deps, CTX, s.get, s.dispatch)
    const taps = await Promise.all([runIssueSave(deps, CTX, s.get, s.dispatch), runIssueSave(deps, CTX, s.get, s.dispatch)])
    expect(taps).toEqual([{ ok: false }, { ok: false }])
    expect(s.get().saving).toBe(true) // the ignored taps did not disturb the running save
    prep.resolve({ ok: true, photo: PHOTO })
    expect(await first).toMatchObject({ ok: true })
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.finalize).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no issue type', (s: ReturnType<typeof store>) => s.dispatch({ type: 'issueType', key: '' }), 'Choose an issue type.'],
    ['a blank description', (s: ReturnType<typeof store>) => s.dispatch({ type: 'description', value: '   ' }), 'Describe the issue.'],
  ])('%s -> message, no server call, not saving', async (_l, mutate, message) => {
    const s = filled()
    mutate(s)
    const deps = { prepare: vi.fn(), finalize: vi.fn() }
    expect(await runIssueSave(deps as unknown as IssueSaveDeps, CTX, s.get, s.dispatch)).toEqual({ ok: false })
    expect(s.get()).toMatchObject({ saving: false, error: message })
    expect(deps.prepare).not.toHaveBeenCalled()
  })
})

describe('long captions are never silently cut', () => {
  const long = 'Scratch on the dining table. '.repeat(60).trim() // > 1,000 chars
  const renderForm = (state: IssueSheetState) =>
    renderToStaticMarkup(
      <PackPhotoIssueForm fieldId="f" state={state} dispatch={() => {}} issueTypes={[]} onSubmit={() => {}} onCancel={() => {}} />,
    )

  it('the description starts as the FULL caption, with the limit explained and saving blocked until it is shortened', async () => {
    expect(long.length).toBeGreaterThan(ISSUE_DESCRIPTION_MAX)
    const s = filled(long)
    expect(s.get().description).toBe(long) // nothing sliced
    expect(s.get().captionOverLimit).toBe(true)

    const html = renderForm(s.get())
    expect(html).toContain(`${long.length.toLocaleString('en-US')} / 1,000 characters`)
    expect(html).toContain('caption is longer than the 1,000-character limit')
    expect(html).toContain('the full caption stays on the pack photo')
    expect(html).toContain('aria-invalid="true"')
    expect(html).not.toContain('maxLength')
    expect(html).not.toContain('maxlength')

    const deps = { prepare: vi.fn(), finalize: vi.fn() }
    expect(await runIssueSave(deps as unknown as IssueSaveDeps, CTX, s.get, s.dispatch)).toEqual({ ok: false })
    expect(s.get().error).toBe(`The description is ${long.length.toLocaleString('en-US')} characters. Shorten it to 1,000 or fewer to save.`)
    expect(s.get().description).toBe(long) // still intact after the refusal
    expect(deps.prepare).not.toHaveBeenCalled()
  })

  it('once shortened it saves; exactly 1,000 characters is allowed', async () => {
    const s = filled(long)
    s.dispatch({ type: 'description', value: 'x'.repeat(ISSUE_DESCRIPTION_MAX) })
    expect(issueSheetBlocker(s.get())).toBeNull()
    expect(renderForm(s.get())).toContain('1,000 / 1,000 characters')
    expect(renderForm(s.get())).not.toContain('role="alert"')
    s.dispatch({ type: 'description', value: 'x'.repeat(ISSUE_DESCRIPTION_MAX + 1) })
    expect(issueSheetBlocker(s.get())).toMatch(/1,001 characters/)
  })

  it('a normal caption shows the count and no warning', () => {
    const html = renderForm(filled().get())
    expect(html).toContain('27 / 1,000 characters')
    expect(html).not.toContain('role="alert"')
  })
})

describe('reducer details', () => {
  it('issue type prefill stops once the reporter has chosen a Category', () => {
    const s = store(initialIssueSheetState(''))
    s.dispatch({ type: 'issueType', key: 'inventory_damaged', defaultPriority: 'med' })
    expect(s.get().selections).toMatchObject({ category: 'inventory', incidentType: 'physical_damage' })
    s.dispatch({ type: 'category', value: 'linen' })
    expect(s.get().selections).toMatchObject({ category: 'linen', incidentType: null })
    s.dispatch({ type: 'issueType', key: 'maintenance_issue', defaultPriority: 'high' })
    expect(s.get().selections.category).toBe('linen')
    expect(s.get().priority).toBe('high')
  })

  it('N/A is exclusive; optional choices can be cleared', () => {
    const s = filled()
    s.dispatch({ type: 'toggleAction', value: 'clean' })
    s.dispatch({ type: 'toggleAction', value: 'na' })
    expect(s.get().selections.actions).toEqual(['na'])
    s.dispatch({ type: 'severity', value: 'minor' })
    s.dispatch({ type: 'severity', value: null })
    expect(s.get().selections.severity).toBeNull()
  })
})

describe('the pack page stays light: nothing but a button per photo until it is opened', () => {
  it('initial render has NO dialog, form, field or thumbnail; saved issues show their real Asana status', async () => {
    const { PackPhotoIssue } = await import('@/components/photos/pack-photo-issue')
    const html = renderToStaticMarkup(
      <PackPhotoIssue
        propertyId={PROP}
        photoId={PACK_PHOTO}
        photoNumber={3}
        thumbUrl="https://example.test/thumb.jpg"
        initialIssues={[
          { flagId: IDS.flagId, asanaStatus: 'needs_attention' },
          { flagId: '11111111-1111-4111-8111-111111111111', asanaStatus: 'unknown' },
        ]}
      />,
    )
    for (const heavy of ['<dialog', '<form', '<input', '<select', '<textarea', '<img', 'thumb.jpg']) {
      expect(html).not.toContain(heavy)
    }
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('Report another issue')
    expect(html).toContain('Asana sync needs attention')
    expect(html).toContain('Asana status unavailable')
    expect(html).not.toContain('Sending to Asana')
  })

  it('the wrapper never imports the sheet statically (it is loaded on first open)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/components/photos/pack-photo-issue.tsx', 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/^import (?!type)[^\n]*pack-photo-issue-(sheet|form)/m)
    expect(code).toContain("await import('@/components/photos/pack-photo-issue-sheet')")
    expect(code).not.toContain('flags/new/actions')
  })
})
