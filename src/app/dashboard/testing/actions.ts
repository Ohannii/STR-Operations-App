'use server'

import { revalidatePath } from 'next/cache'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { canManageTesting, testingError, TEST_SESSION_MINUTES, validTestReason } from '@/lib/testing/test-mode'

export type TestingResult = { ok: true } | { ok: false; error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

const refresh = () => {
  revalidatePath('/dashboard', 'layout')
  revalidatePath('/properties', 'layout')
}

async function managerContext() {
  const ctx = await getUserContext()
  if (!ctx?.company || !canManageTesting(ctx.membership?.role_key)) return null
  return ctx
}

/**
 * Start test mode for the signed-in manager on ONE apartment (or return the
 * one already running for that apartment). Only issues this manager raises
 * on that apartment are test issues.
 */
export async function startTestMode(input: { propertyId: string; minutes: number; reason: string }): Promise<TestingResult> {
  const ctx = await managerContext()
  if (!ctx) return { ok: false, error: testingError({ code: '42501' }) }
  if (!input || !validId(input.propertyId) || !(TEST_SESSION_MINUTES as readonly number[]).includes(input.minutes) || !validTestReason(input.reason)) {
    return { ok: false, error: testingError({ code: '22023' }) }
  }
  try {
    const db = await createClient()
    const { error } = await db.rpc('start_test_session', {
      p_company_id: ctx.company!.id, p_property_id: input.propertyId, p_minutes: input.minutes, p_reason: input.reason.trim(),
    })
    if (error) return { ok: false, error: testingError(error) }
    refresh()
    return { ok: true }
  } catch { return { ok: false, error: testingError(null) } }
}

/** End the signed-in person's own test session. Any member may end their own. */
export async function endTestMode(): Promise<TestingResult> {
  const ctx = await getUserContext()
  if (!ctx?.company) return { ok: false, error: testingError({ code: '42501' }) }
  try {
    const db = await createClient()
    const { error } = await db.rpc('end_test_session', { p_company_id: ctx.company.id })
    if (error) return { ok: false, error: testingError(error) }
    refresh()
    return { ok: true }
  } catch { return { ok: false, error: testingError(null) } }
}

/** Mark or unmark a test apartment. Company always comes from the session. */
export async function setPropertyTestStatus(input: { propertyId: string; isTest: boolean; reason: string }): Promise<TestingResult> {
  const ctx = await managerContext()
  if (!ctx) return { ok: false, error: testingError({ code: '42501' }) }
  if (!input || !validId(input.propertyId) || typeof input.isTest !== 'boolean' || !validTestReason(input.reason)) {
    return { ok: false, error: testingError({ code: '22023' }) }
  }
  try {
    const db = await createClient()
    const { error } = await db.rpc('set_property_test_status', {
      p_company_id: ctx.company!.id, p_property_id: input.propertyId, p_is_test: input.isTest, p_reason: input.reason.trim(),
    })
    if (error) return { ok: false, error: testingError(error) }
    refresh()
    return { ok: true }
  } catch { return { ok: false, error: testingError(null) } }
}
