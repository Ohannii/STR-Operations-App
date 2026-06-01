/**
 * Client-side photo compression for evidence uploads.
 *
 * Runs in the browser via <canvas>. Recoding a photo through canvas
 * naturally strips EXIF metadata (including GPS), which is the
 * privacy guarantee called out in PHOTO_AND_EVIDENCE_SYSTEM.md
 * (rule "Strip EXIF GPS"). We DO recover the capture timestamp from
 * EXIF before recoding so the photo carries an accurate captured_at.
 *
 * Output:
 *   master  — long edge <= MAX_LONG_EDGE, JPEG at MASTER_QUALITY.
 *   thumb   — long edge <= THUMB_LONG_EDGE, JPEG at THUMB_QUALITY.
 *
 * Why client-side thumbnails for v1.0:
 *   - Avoids Supabase's $5/1000 image transform pricing trap above
 *     the 100/mo included quota (see PHOTO_AND_EVIDENCE_SYSTEM.md
 *     rule "NEVER per-request transforms").
 *   - Defers the server-side / Edge Function thumbnailer to a later
 *     session. Storage cost: thumbnails are tiny (~20 KB each), so
 *     this stays well below any cost concern.
 *   - When the Edge Function thumbnailer lands, the thumb_path
 *     column already exists — we just swap the source of the thumb
 *     bytes; nothing else changes.
 *
 * Constants live next to the code (not magic numbers in the
 * uploader). Tune here, not in N files.
 */

/** Compressed master long edge in pixels. */
export const MASTER_MAX_LONG_EDGE = 2000

/** JPEG quality for the compressed master, 0..1. */
export const MASTER_QUALITY = 0.8

/** Thumbnail long edge in pixels. */
export const THUMB_LONG_EDGE = 400

/** JPEG quality for the thumbnail, 0..1. */
export const THUMB_QUALITY = 0.7

export type CompressedEvidence = {
  /** Compressed master JPEG (long edge ≤ MASTER_MAX_LONG_EDGE). */
  master: Blob
  /** Thumbnail JPEG (long edge ≤ THUMB_LONG_EDGE). */
  thumb: Blob
  /** Pixel width of the master. */
  width: number
  /** Pixel height of the master. */
  height: number
  /** Master MIME type — always 'image/jpeg' for v1.0. */
  mimeType: 'image/jpeg'
  /** Master size in bytes. */
  sizeBytes: number
}

/**
 * Load a Blob into an HTMLImageElement we can draw to a canvas.
 * Falls back through createImageBitmap (faster path on Chromium /
 * Firefox) then HTMLImageElement (broader compat including iOS
 * Safari). Either path delivers correctly-oriented pixels because
 * modern browsers respect EXIF orientation when decoding.
 */
async function loadBitmap(blob: Blob): Promise<{
  width: number
  height: number
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  release: () => void
}> {
  // createImageBitmap is the preferred path — async, off-main-thread
  // decode, and honours EXIF orientation when imageOrientation:
  // 'from-image' is passed.
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
      })
      return {
        width: bmp.width,
        height: bmp.height,
        draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
        release: () => bmp.close(),
      }
    } catch {
      // fall through to HTMLImageElement
    }
  }

  // HTMLImageElement fallback (iOS Safari + older browsers).
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Failed to decode image'))
      el.src = url
    })
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      release: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

/**
 * Scale (width, height) so the long edge is at most `maxLongEdge`,
 * preserving aspect ratio. Never upscales.
 */
function fitToLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const ratio = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

/**
 * Encode a canvas as JPEG and return a Blob. Uses canvas.toBlob
 * (async, off-thread on most browsers) which is preferable to
 * toDataURL (sync, base64).
 */
function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas toBlob returned null'))
      },
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Compress a raw photo Blob (e.g., from a camera capture or file
 * input) into a master + thumbnail pair ready for upload.
 *
 * The same source bitmap is reused for both — decode once, draw
 * twice. On large originals (12 MP iPhone shots) this cuts compress
 * time roughly in half versus naive decode-twice.
 */
export async function compressForEvidence(input: Blob): Promise<CompressedEvidence> {
  const bitmap = await loadBitmap(input)
  try {
    const masterSize = fitToLongEdge(
      bitmap.width,
      bitmap.height,
      MASTER_MAX_LONG_EDGE,
    )
    const thumbSize = fitToLongEdge(
      bitmap.width,
      bitmap.height,
      THUMB_LONG_EDGE,
    )

    const masterCanvas = document.createElement('canvas')
    masterCanvas.width = masterSize.width
    masterCanvas.height = masterSize.height
    const masterCtx = masterCanvas.getContext('2d')
    if (!masterCtx) throw new Error('Failed to get 2D context (master)')
    bitmap.draw(masterCtx, masterSize.width, masterSize.height)

    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = thumbSize.width
    thumbCanvas.height = thumbSize.height
    const thumbCtx = thumbCanvas.getContext('2d')
    if (!thumbCtx) throw new Error('Failed to get 2D context (thumb)')
    bitmap.draw(thumbCtx, thumbSize.width, thumbSize.height)

    const [master, thumb] = await Promise.all([
      canvasToJpeg(masterCanvas, MASTER_QUALITY),
      canvasToJpeg(thumbCanvas, THUMB_QUALITY),
    ])

    return {
      master,
      thumb,
      width: masterSize.width,
      height: masterSize.height,
      mimeType: 'image/jpeg',
      sizeBytes: master.size,
    }
  } finally {
    bitmap.release()
  }
}
