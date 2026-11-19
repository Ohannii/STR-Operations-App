/**
 * State machine for the "Report issue" sheet (pure; no React, no I/O).
 *
 * THE FREEZE RULE: while a save is running (`saving`), every edit action is
 * IGNORED by the reducer. What is on screen when Save is tapped is exactly
 * what is sent and exactly what is saved — an edit can never slip in
 * between "photo prepared" and "issue saved", and a success can never clear
 * input the reporter typed after tapping Save. (The form's controls are
 * also disabled while saving; the reducer is the guarantee.)
 *
 * A failed save returns to editing with EVERYTHING retained.
 */

import type { AsanaIssueStatus } from '@/lib/issues/asana-status'
import {
  EMPTY_SELECTIONS,
  prefillFromIssueType,
  toggleAction,
  type IssueAction,
  type IssueCategory,
  type IssueFixOwner,
  type IssueSelections,
  type IssueSeverity,
} from '@/lib/issues/issue-selections'
import type { IssuePhotoDescriptor } from '@/lib/issues/prepare-issue-photo'

/** Server limit for an issue description (flags.description). */
export const ISSUE_DESCRIPTION_MAX = 1000

/** 1234 -> "1,234" (fixed format; no locale differences between devices). */
export const formatCount = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export type IssuePriority = 'low' | 'med' | 'high'

export type IssueSheetState = {
  issueType: string
  priority: IssuePriority
  description: string
  /** The description was prefilled from a caption longer than the limit. */
  captionOverLimit: boolean
  selections: IssueSelections
  /** Category / incident type chosen by the reporter (stop prefilling). */
  categoryTouched: boolean
  moreOpen: boolean
  saving: boolean
  error: string | null
  /** The issue's copied photo, kept across retries of the SAME issue. */
  prepared: IssuePhotoDescriptor | null
}

/**
 * Initial state. The description starts as the photo's CURRENT caption, in
 * full — never silently cut. If it is longer than the limit the reporter is
 * told and must shorten the description (the caption itself is untouched).
 */
export function initialIssueSheetState(caption: string): IssueSheetState {
  const description = caption ?? ''
  return {
    issueType: '',
    priority: 'med',
    description,
    captionOverLimit: description.trim().length > ISSUE_DESCRIPTION_MAX,
    selections: { ...EMPTY_SELECTIONS },
    categoryTouched: false,
    moreOpen: false,
    saving: false,
    error: null,
    prepared: null,
  }
}

export type IssueSheetAction =
  | { type: 'issueType'; key: string; defaultPriority?: IssuePriority }
  | { type: 'priority'; value: IssuePriority }
  | { type: 'description'; value: string }
  | { type: 'category'; value: IssueCategory | null }
  | { type: 'incidentType'; value: string | null }
  | { type: 'toggleAction'; value: IssueAction }
  | { type: 'severity'; value: IssueSeverity | null }
  | { type: 'fixOwner'; value: IssueFixOwner | null }
  | { type: 'toggleMore' }
  | { type: 'invalid'; error: string }
  | { type: 'saveStarted' }
  | { type: 'photoPrepared'; photo: IssuePhotoDescriptor }
  | { type: 'saveFailed'; error: string }

const SAVE_LIFECYCLE = new Set<IssueSheetAction['type']>(['saveStarted', 'photoPrepared', 'saveFailed'])

export function issueSheetReducer(state: IssueSheetState, action: IssueSheetAction): IssueSheetState {
  // THE FREEZE RULE: nothing but the save's own lifecycle changes state.
  if (state.saving && !SAVE_LIFECYCLE.has(action.type)) return state

  switch (action.type) {
    case 'issueType': {
      const next: IssueSheetState = { ...state, issueType: action.key }
      if (action.defaultPriority) next.priority = action.defaultPriority
      if (!state.categoryTouched) {
        next.selections = { ...state.selections, ...prefillFromIssueType(action.key) }
      }
      return next
    }
    case 'priority':
      return { ...state, priority: action.value }
    case 'description':
      return { ...state, description: action.value }
    case 'category':
      return {
        ...state,
        categoryTouched: true,
        selections: {
          ...state.selections,
          category: action.value,
          // An incident type only applies to its own Category.
          incidentType: action.value === state.selections.category ? state.selections.incidentType : null,
        },
      }
    case 'incidentType':
      return { ...state, categoryTouched: true, selections: { ...state.selections, incidentType: action.value } }
    case 'toggleAction':
      return {
        ...state,
        selections: { ...state.selections, actions: toggleAction(state.selections.actions, action.value) },
      }
    case 'severity':
      return { ...state, selections: { ...state.selections, severity: action.value } }
    case 'fixOwner':
      return { ...state, selections: { ...state.selections, fixOwner: action.value } }
    case 'toggleMore':
      return { ...state, moreOpen: !state.moreOpen }
    case 'invalid':
      return { ...state, error: action.error }
    case 'saveStarted':
      return state.saving ? state : { ...state, saving: true, error: null }
    case 'photoPrepared':
      return { ...state, prepared: action.photo }
    case 'saveFailed':
      // Back to editing; every entered value is kept.
      return { ...state, saving: false, error: action.error }
  }
}

/** Why the form cannot be saved yet, or null when it can. */
export function issueSheetBlocker(state: IssueSheetState): string | null {
  if (!state.issueType) return 'Choose an issue type.'
  const length = state.description.trim().length
  if (length === 0) return 'Describe the issue.'
  if (length > ISSUE_DESCRIPTION_MAX) {
    return `The description is ${formatCount(length)} characters. Shorten it to ${formatCount(ISSUE_DESCRIPTION_MAX)} or fewer to save.`
  }
  return null
}

export const ISSUE_SAVE_FAILED =
  'Could not save the issue. Check your connection and tap Save issue again — your details are kept.'

export type IssueSaveDeps = {
  prepare: (input: {
    propertyId: string
    proposedFlagId: string
    packPhotoId: string
    newPhotoId: string
  }) => Promise<{ ok: true; photo: IssuePhotoDescriptor } | { ok: false; error: string }>
  finalize: (input: {
    propertyId: string
    proposedFlagId: string
    categoryKey: string
    severity: IssuePriority
    description: string
    issueTitle: null
    accountability: null
    photos: IssuePhotoDescriptor[]
    issue: { sourcePackPhotoId: string; selections: IssueSelections }
  }) => Promise<{ ok: true; flagId: string; asanaStatus: AsanaIssueStatus } | { ok: false; error: string }>
}

export type IssueSaveOutcome =
  | { ok: true; flagId: string; asanaStatus: AsanaIssueStatus }
  | { ok: false }

/**
 * One save attempt. `getState` must return the CURRENT state (so the
 * single-flight check is race-free); the values sent are a snapshot taken
 * at the moment the save starts. Never throws.
 *
 * `ids` are fixed for the whole issue (all retries), so a retry can only
 * ever replay the same issue — never create a second one.
 */
export async function runIssueSave(
  deps: IssueSaveDeps,
  ctx: { propertyId: string; packPhotoId: string; ids: { flagId: string; photoId: string } },
  getState: () => IssueSheetState,
  dispatch: (action: IssueSheetAction) => void,
): Promise<IssueSaveOutcome> {
  const snapshot = getState()
  if (snapshot.saving) return { ok: false } // single flight: repeated taps do nothing
  const blocker = issueSheetBlocker(snapshot)
  if (blocker) {
    dispatch({ type: 'invalid', error: blocker })
    return { ok: false }
  }
  dispatch({ type: 'saveStarted' })
  try {
    let photo = snapshot.prepared
    if (!photo) {
      const p = await deps.prepare({
        propertyId: ctx.propertyId,
        proposedFlagId: ctx.ids.flagId,
        packPhotoId: ctx.packPhotoId,
        newPhotoId: ctx.ids.photoId,
      })
      if (!p.ok) {
        dispatch({ type: 'saveFailed', error: p.error })
        return { ok: false }
      }
      photo = p.photo
      dispatch({ type: 'photoPrepared', photo })
    }
    const res = await deps.finalize({
      propertyId: ctx.propertyId,
      proposedFlagId: ctx.ids.flagId,
      categoryKey: snapshot.issueType,
      severity: snapshot.priority,
      description: snapshot.description.trim(),
      issueTitle: null,
      accountability: null,
      photos: [photo],
      issue: { sourcePackPhotoId: ctx.packPhotoId, selections: snapshot.selections },
    })
    if (!res.ok) {
      dispatch({ type: 'saveFailed', error: res.error })
      return { ok: false }
    }
    // Success: the caller unmounts the sheet (state is discarded whole).
    return { ok: true, flagId: res.flagId, asanaStatus: res.asanaStatus }
  } catch {
    dispatch({ type: 'saveFailed', error: ISSUE_SAVE_FAILED })
    return { ok: false }
  }
}
