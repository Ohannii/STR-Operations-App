import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Invite acceptance must capture the member's name so people show by name
 * (not email) on the Team list and dashboard. These source-level checks pin
 * the contract without a full Supabase mock harness.
 */
const root = process.cwd()
const page = readFileSync(
  resolve(root, 'src/app/invite/set-password/page.tsx'),
  'utf8',
)
const action = readFileSync(
  resolve(root, 'src/app/invite/set-password/actions.ts'),
  'utf8',
)

describe('invite set-password captures the member name', () => {
  it('the form has a required "Your name" field named full_name', () => {
    expect(page).toContain('name="full_name"')
    expect(page).toContain('label="Your name" required')
  })

  it('the action reads and requires the name', () => {
    expect(action).toContain("formData.get('full_name')")
    expect(action).toContain('Please enter your name.')
  })

  it('the action saves the name to the user profile', () => {
    expect(action).toContain(".from('profiles')")
    expect(action).toMatch(/\.update\(\{\s*full_name/)
    // scoped to the authenticated user's own row (self-update policy)
    expect(action).toContain(".eq('id', user.id)")
  })
})
