import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/health
 *
 * Verifies the Supabase connection is reachable and the env vars are wired up.
 * - Returns { status: 'ok' } if Supabase responds (even with no session — expected).
 * - Returns { status: 'error', message } if the URL or key is wrong.
 *
 * This route is for local connection verification only.
 * It can be removed before v1.0 ships to production.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    // getUser() makes a real network call to the Supabase Auth API.
    // On a fresh project with no logged-in user, it returns an
    // "Auth session missing" error — that is the expected healthy response.
    // A network failure or invalid key produces a different error.
    const { error } = await supabase.auth.getUser()

    if (error && !error.message.includes('Auth session missing')) {
      return NextResponse.json(
        { status: 'error', message: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      status: 'ok',
      message: 'Supabase reachable — no active session (expected for fresh project)',
    })
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
