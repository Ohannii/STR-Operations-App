import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression for the PR #60 duplicate password-form submission: the password
 * forms must use SubmitButton, which disables itself while the server action is
 * pending, preventing a second submit.
 */
const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const invitePage = read('src/app/invite/set-password/page.tsx')
const resetPage = read('src/app/reset-password/page.tsx')
const submitBtn = read('src/components/ui/submit-button.tsx')

describe('password forms guard against double-submit via SubmitButton', () => {
  it('the invite set-password form renders SubmitButton (full width, Saving pending label)', () => {
    expect(invitePage).toContain("from '@/components/ui/submit-button'")
    expect(invitePage).toContain('<SubmitButton')
    expect(invitePage).toContain('fullWidth')
    expect(invitePage).toContain('pendingLabel="Saving')
    expect(invitePage).not.toContain('<Button') // ordinary Button no longer used here
  })

  it('the reset-password form also uses SubmitButton', () => {
    expect(resetPage).toContain('<SubmitButton')
    expect(resetPage).not.toContain('<Button')
  })

  it('SubmitButton disables itself while the action is pending', () => {
    expect(submitBtn).toContain('useFormStatus')
    expect(submitBtn).toContain('disabled={pending}')
    expect(submitBtn).toContain('aria-busy={pending}')
  })

  it('SubmitButton supports fullWidth (w-full) through buttonClasses', () => {
    expect(submitBtn).toMatch(/fullWidth \? 'w-full'/)
  })
})
