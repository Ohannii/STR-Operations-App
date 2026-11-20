import { ChevronDown, Loader2 } from 'lucide-react'
import {
  ISSUE_ACTIONS,
  ISSUE_CATEGORIES,
  ISSUE_FIX_OWNERS,
  ISSUE_SEVERITIES,
  incidentTypesFor,
} from '@/lib/issues/issue-selections'
import {
  ISSUE_DESCRIPTION_MAX,
  formatCount,
  type IssuePriority,
  type IssueSheetAction,
  type IssueSheetState,
} from '@/lib/issues/issue-sheet-state'

/**
 * The "Report issue" form — a pure view of IssueSheetState (no state, no
 * server calls of its own), so its behaviour is fully determined by the
 * state machine in issue-sheet-state.ts.
 *
 * While `state.saving`, EVERY field is disabled (one <fieldset disabled>),
 * as are Cancel and Save: what is on screen is what is being saved.
 */

export type IssueTypeOption = { key: string; label: string; severityDefault: IssuePriority }

const fmt = formatCount

export function PackPhotoIssueForm({
  fieldId,
  state,
  dispatch,
  issueTypes,
  thumbUrl,
  onSubmit,
  onCancel,
}: {
  fieldId: string
  state: IssueSheetState
  dispatch: (action: IssueSheetAction) => void
  issueTypes: IssueTypeOption[]
  thumbUrl?: string
  onSubmit: () => void
  onCancel: () => void
}) {
  const { selections, saving } = state
  const incidentOptions = incidentTypesFor(selections.category)
  const length = state.description.trim().length
  const over = length > ISSUE_DESCRIPTION_MAX

  return (
    <form
      className="px-5 py-4"
      aria-busy={saving}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <fieldset disabled={saving} className="m-0 min-w-0 space-y-5 border-0 p-0 disabled:opacity-70">
        <div className="flex items-center gap-3">
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" />
          ) : null}
          <p className="text-sm text-slate-600">
            This photo is attached to the issue. The pack photo and its caption stay as they are.
          </p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-type`} className="block text-sm font-medium text-slate-800">
            Issue type <span className="text-red-600">*</span>
          </label>
          <div className="relative mt-1.5">
            <select
              id={`${fieldId}-type`}
              value={state.issueType}
              required
              onChange={(e) => {
                const t = issueTypes.find((x) => x.key === e.target.value)
                dispatch({ type: 'issueType', key: e.target.value, defaultPriority: t?.severityDefault })
              }}
              className="block w-full min-h-11 appearance-none rounded-md border border-slate-300 bg-white pl-3 pr-9 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="" disabled>
                Select issue type
              </option>
              {issueTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${fieldId}-desc`} className="block text-sm font-medium text-slate-800">
            What did you find? <span className="text-red-600">*</span>
          </label>
          <textarea
            id={`${fieldId}-desc`}
            value={state.description}
            required
            rows={3}
            aria-describedby={`${fieldId}-desc-help`}
            aria-invalid={over}
            onChange={(e) => dispatch({ type: 'description', value: e.target.value })}
            placeholder="Describe the issue…"
            className={`mt-1.5 block w-full min-h-[5rem] resize-y rounded-md border px-3 py-2 text-base text-slate-900 focus:outline-none focus:ring-2 ${
              over
                ? 'border-red-400 focus:border-red-600 focus:ring-red-600'
                : 'border-slate-300 focus:border-slate-900 focus:ring-slate-900'
            }`}
          />
          <div id={`${fieldId}-desc-help`} className="mt-1 space-y-1 text-xs">
            <p className={over ? 'font-medium text-red-700' : 'text-slate-500'} data-testid="desc-count">
              {fmt(length)} / {fmt(ISSUE_DESCRIPTION_MAX)} characters
            </p>
            {over ? (
              <p role="alert" className="text-red-700">
                {state.captionOverLimit
                  ? `This photo’s caption is longer than the ${fmt(ISSUE_DESCRIPTION_MAX)}-character limit for an issue description. Shorten the description here to save — the full caption stays on the pack photo.`
                  : `An issue description can be up to ${fmt(ISSUE_DESCRIPTION_MAX)} characters. Shorten it to save.`}
              </p>
            ) : null}
          </div>
        </div>

        <ChipGroup legend="Priority" required>
          {(['low', 'med', 'high'] as const).map((p) => (
            <Chip
              key={p}
              type="radio"
              name={`${fieldId}-priority`}
              checked={state.priority === p}
              onChange={() => dispatch({ type: 'priority', value: p })}
              label={p === 'low' ? 'Low' : p === 'med' ? 'Medium' : 'High'}
            />
          ))}
        </ChipGroup>

        <ChipGroup legend="Category" hint="For Asana. Optional.">
          {ISSUE_CATEGORIES.map((c) => (
            <Chip
              key={c.key}
              type="radio"
              name={`${fieldId}-category`}
              checked={selections.category === c.key}
              onChange={() => dispatch({ type: 'category', value: c.key })}
              onClickChecked={() => dispatch({ type: 'category', value: null })}
              label={c.label}
            />
          ))}
        </ChipGroup>

        {incidentOptions.length > 0 ? (
          <ChipGroup
            legend={`${ISSUE_CATEGORIES.find((c) => c.key === selections.category)?.label} incident type`}
            hint="Optional."
          >
            {incidentOptions.map((t) => (
              <Chip
                key={t.key}
                type="radio"
                name={`${fieldId}-incident`}
                checked={selections.incidentType === t.key}
                onChange={() => dispatch({ type: 'incidentType', value: t.key })}
                onClickChecked={() => dispatch({ type: 'incidentType', value: null })}
                label={t.label}
              />
            ))}
          </ChipGroup>
        ) : null}

        <ChipGroup legend="What needs to happen?" hint="Choose all that apply.">
          {ISSUE_ACTIONS.map((a) => (
            <Chip
              key={a.key}
              type="checkbox"
              name={`${fieldId}-actions`}
              checked={selections.actions.includes(a.key)}
              onChange={() => dispatch({ type: 'toggleAction', value: a.key })}
              label={a.label}
            />
          ))}
        </ChipGroup>

        <div className="rounded-md border border-slate-200">
          <button
            type="button"
            aria-expanded={state.moreOpen}
            aria-controls={`${fieldId}-more`}
            onClick={() => dispatch({ type: 'toggleMore' })}
            className="flex min-h-11 w-full items-center justify-between px-3 text-sm font-medium text-slate-700"
          >
            More details (optional)
            <ChevronDown size={16} aria-hidden className={state.moreOpen ? 'rotate-180 transition' : 'transition'} />
          </button>
          <div
            id={`${fieldId}-more`}
            hidden={!state.moreOpen}
            className="space-y-4 border-t border-slate-200 px-3 py-3"
          >
            <ChipGroup legend="Severity" hint="Leave blank for triage.">
              {ISSUE_SEVERITIES.map((s) => (
                <Chip
                  key={s.key}
                  type="radio"
                  name={`${fieldId}-severity`}
                  checked={selections.severity === s.key}
                  onChange={() => dispatch({ type: 'severity', value: s.key })}
                  onClickChecked={() => dispatch({ type: 'severity', value: null })}
                  label={s.label}
                />
              ))}
            </ChipGroup>
            <ChipGroup legend="Fix owner" hint="Leave blank for triage.">
              {ISSUE_FIX_OWNERS.map((o) => (
                <Chip
                  key={o.key}
                  type="radio"
                  name={`${fieldId}-owner`}
                  checked={selections.fixOwner === o.key}
                  onChange={() => dispatch({ type: 'fixOwner', value: o.key })}
                  onClickChecked={() => dispatch({ type: 'fixOwner', value: null })}
                  label={o.label}
                />
              ))}
            </ChipGroup>
          </div>
        </div>
      </fieldset>

      {state.error ? (
        <p role="alert" className="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-5 mt-5 flex items-center justify-end gap-3 border-t border-slate-200 bg-white px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-base font-medium text-slate-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          aria-busy={saving}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-base font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
          {saving ? 'Saving issue…' : 'Save issue'}
        </button>
      </div>
    </form>
  )
}

function ChipGroup({
  legend,
  hint,
  required,
  children,
}: {
  legend: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-800">
        {legend} {required ? <span className="text-red-600">*</span> : null}
        {hint ? <span className="ml-1 font-normal text-slate-500">{hint}</span> : null}
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  )
}

/**
 * Large, accessible chip (real radio / checkbox input). For optional radio
 * groups, tapping the selected chip again clears it (`onClickChecked`).
 */
function Chip({
  type,
  name,
  checked,
  onChange,
  onClickChecked,
  label,
}: {
  type: 'radio' | 'checkbox'
  name: string
  checked: boolean
  onChange: () => void
  onClickChecked?: () => void
  label: string
}) {
  return (
    <label className="inline-flex cursor-pointer">
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        onClick={() => {
          if (type === 'radio' && checked && onClickChecked) onClickChecked()
        }}
        className="peer sr-only"
      />
      <span className="inline-flex min-h-11 items-center rounded-full border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors peer-checked:border-slate-900 peer-checked:bg-slate-900 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900 peer-focus-visible:ring-offset-2">
        {label}
      </span>
    </label>
  )
}
