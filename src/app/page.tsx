import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /
 *
 * Always redirects: logged-in → /dashboard, logged-out → /login.
 * The dashboard page itself will bounce the user to /onboard if
 * they don't yet have a company.
 */
export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  }
  redirect('/login')
}
