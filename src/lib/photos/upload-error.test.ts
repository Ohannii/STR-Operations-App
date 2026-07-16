import { describe, it, expect } from 'vitest'
import { describeUploadFailure } from '@/lib/photos/upload-error'

describe('describeUploadFailure', () => {
  it('surfaces the JSON message field with the status', () => {
    const body = JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
    expect(describeUploadFailure(403, body)).toBe(
      'Upload failed (403): new row violates row-level security policy',
    )
  })

  it('falls back to the JSON error field when there is no message', () => {
    expect(describeUploadFailure(409, JSON.stringify({ error: 'Duplicate' }))).toBe(
      'Upload failed (409): Duplicate',
    )
  })

  it('gives a generic status message when the body is empty', () => {
    expect(describeUploadFailure(500, '')).toBe('Upload failed (500).')
    expect(describeUploadFailure(500, null)).toBe('Upload failed (500).')
  })

  it('does not echo arbitrary non-JSON body text (no leak of raw content)', () => {
    const raw = 'https://project.supabase.co/storage/v1/object/upload/sign/x?token=SECRET'
    const out = describeUploadFailure(400, raw)
    expect(out).toBe('Upload failed (400).')
    expect(out).not.toContain('token')
    expect(out).not.toContain('SECRET')
  })

  it('caps an overly long message', () => {
    const long = 'x'.repeat(500)
    const out = describeUploadFailure(400, JSON.stringify({ message: long }))
    expect(out.length).toBeLessThan(200)
  })
})
