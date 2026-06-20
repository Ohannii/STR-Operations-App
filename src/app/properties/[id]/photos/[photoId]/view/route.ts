import { NextResponse } from 'next/server'
import { EVIDENCE_BUCKET } from '@/lib/photos/paths'
import { MASTER_TTL_SECONDS } from '@/lib/photos/signed-urls'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /properties/[id]/photos/[photoId]/view
 *
 * Signs the photo's master object URL on demand and 302-redirects
 * the browser straight to Supabase Storage. Two reasons this route
 * exists rather than pre-signing master URLs at page render:
 *
 *   1. Cost / load. On a flag detail page with 20 photos, signing
 *      20 master URLs at render time costs 20 createSignedUrl
 *      calls plus 20 short-TTL URLs that mostly expire unused.
 *      Signing on click means we sign exactly the masters the
 *      user actually opens.
 *
 *   2. Freshness. Master URLs have a short TTL (5 min). If a user
 *      sits on the detail page for 6 minutes and then clicks, a
 *      pre-signed URL would 403. Signing on click guarantees a
 *      fresh URL.
 *
 * RLS on public.photos is the access gatekeeper — the SELECT here
 * will silently miss if the user isn't a company member with read
 * access to this photo.
 *
 * Bytes are never proxied through Node. The 302 sends the browser
 * directly to storage, identical to clicking a pre-signed URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const { id: propertyId, photoId } = await params

  const supabase = await createClient()

  // Verify the photo exists, belongs to this property, and is not
  // soft-deleted. RLS scopes by company; this extra .eq() guards
  // against URL-tampering across properties within the same
  // company.
  const { data: photo, error } = await supabase
    .from('photos')
    .select('storage_path, property_id')
    .eq('id', photoId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{ storage_path: string; property_id: string }>()

  if (error) {
    console.error('[photos/view] lookup error:', error)
    return new NextResponse('Not found', { status: 404 })
  }
  if (!photo) {
    return new NextResponse('Not found', { status: 404 })
  }

  const { data, error: signErr } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(photo.storage_path, MASTER_TTL_SECONDS)

  if (signErr || !data) {
    console.error('[photos/view] sign error:', signErr)
    return new NextResponse('Failed to sign URL', { status: 500 })
  }

  return NextResponse.redirect(data.signedUrl, 302)
}
