'use client'

/**
 * Share PDF — Slice 11C1. The primary beta outcome: real Android/iPhone
 * file sharing of the report PDF (WhatsApp/email get an actual attachment).
 *
 * Flow:
 *   - On mount, PREPARE: POST the prepare route → { url, filename }, then
 *     fetch the PDF bytes DIRECTLY from Supabase Storage (bypasses Vercel's
 *     4.5 MB response limit) and build a File. This happens BEFORE any tap
 *     so the share call stays inside the user gesture.
 *   - On tap: synchronously navigator.canShare({files}) → navigator.share
 *     ({files:[file]}). AbortError = user cancellation (not an error).
 *   - If file sharing is unsupported (or share fails non-abort): show an
 *     explicit "open in Chrome/Safari" hint + a Download PDF fallback.
 *   - Never opens the print dialog; never shares a URL instead of the file.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, RotateCw, Share2 } from 'lucide-react'

type PrepareOk = { url: string; filename: string }
type Phase = 'preparing' | 'ready' | 'error'

type NavigatorWithShare = Navigator & {
  canShare?: (data?: ShareData) => boolean
  share?: (data?: ShareData) => Promise<void>
}

type PreparedPdf = { file: File; objectUrl: string }

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/**
 * PURE async loader — contains NO React state. Runs the prepare POST, fetches
 * the PDF Blob directly from Storage, and returns the ready File plus its
 * object URL. Accepts an AbortSignal so an in-flight preparation can be
 * cancelled. The effect subscribes via .then/.catch — the supported pattern
 * for updating state from an external async result — so the effect itself
 * never (directly or indirectly) calls a state setter.
 */
async function loadPdf(prepareUrl: string, signal: AbortSignal): Promise<PreparedPdf> {
  const res = await fetch(prepareUrl, { method: 'POST', signal })
  const json = (await res.json().catch(() => ({}))) as Partial<PrepareOk> & {
    error?: string
  }
  if (!res.ok || !json.url || !json.filename) {
    throw new Error(json.error || 'Could not prepare the PDF.')
  }
  const pdfRes = await fetch(json.url, { signal })
  if (!pdfRes.ok) throw new Error('Could not download the prepared PDF.')
  const blob = await pdfRes.blob()
  const file = new File([blob], json.filename, { type: 'application/pdf' })
  return { file, objectUrl: URL.createObjectURL(file) }
}

export function SharePdfButton({
  prepareUrl,
  shareTitle,
}: {
  prepareUrl: string
  shareTitle: string
}) {
  const [phase, setPhase] = useState<Phase>('preparing')
  const [file, setFile] = useState<File | null>(null)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallback, setFallback] = useState(false)
  // Live object URL (for revocation across reloads/unmount), mount tracking,
  // and a handle to abort a retry in flight.
  const objectUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const retryAbortRef = useRef<AbortController | null>(null)

  // Mount: subscribe to the PURE loader. The effect performs NO synchronous
  // state update and calls only the pure loader; state is set exclusively in
  // the .then/.catch callbacks, when still mounted and not cancelled — the
  // supported external-async-result pattern for react-hooks/set-state-in-effect.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    loadPdf(prepareUrl, controller.signal)
      .then((prepared) => {
        if (cancelled || !mountedRef.current) {
          URL.revokeObjectURL(prepared.objectUrl)
          return
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = prepared.objectUrl
        setFile(prepared.file)
        setObjectUrl(prepared.objectUrl)
        setPhase('ready')
      })
      .catch((e: unknown) => {
        if (cancelled || isAbort(e)) return
        setPhase('error')
        setError(e instanceof Error ? e.message : 'Could not prepare the PDF.')
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [prepareUrl])

  // Unmount bookkeeping: block late state updates, abort a retry in flight,
  // and revoke the live object URL.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      retryAbortRef.current?.abort()
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [])

  // Retry is a USER event, so the synchronous reset is allowed. It awaits the
  // same pure loader and updates ready/error state, guarding against stale or
  // post-unmount updates and revoking a superseded object URL.
  const onRetry = useCallback(() => {
    setPhase('preparing')
    setError(null)
    setFallback(false)
    retryAbortRef.current?.abort()
    const controller = new AbortController()
    retryAbortRef.current = controller
    loadPdf(prepareUrl, controller.signal)
      .then((prepared) => {
        if (!mountedRef.current) {
          URL.revokeObjectURL(prepared.objectUrl)
          return
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = prepared.objectUrl
        setFile(prepared.file)
        setObjectUrl(prepared.objectUrl)
        setPhase('ready')
      })
      .catch((e: unknown) => {
        if (!mountedRef.current || isAbort(e)) return
        setPhase('error')
        setError(e instanceof Error ? e.message : 'Could not prepare the PDF.')
      })
  }, [prepareUrl])

  const onShare = useCallback(async () => {
    if (!file) return
    const nav = navigator as NavigatorWithShare
    // Feature-detect synchronously, then call share() as the first async
    // op so the user activation is preserved.
    if (
      typeof nav.share === 'function' &&
      typeof nav.canShare === 'function' &&
      nav.canShare({ files: [file] })
    ) {
      try {
        await nav.share({ files: [file], title: shareTitle })
      } catch (e) {
        // AbortError = user cancelled the share sheet — not a failure.
        if ((e as Error)?.name !== 'AbortError') {
          setFallback(true)
        }
      }
      return
    }
    // No file-share support on this browser (e.g. some in-app webviews).
    setFallback(true)
  }, [file, shareTitle])

  if (phase === 'preparing') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-900/90 text-white px-3.5 py-1.5 text-sm font-medium opacity-80">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        Preparing PDF…
      </span>
    )
  }

  if (phase === 'error') {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
        >
          <RotateCw size={14} aria-hidden />
          Retry preparation
        </button>
        {error ? <span className="text-xs text-red-600 max-w-[16rem] text-right">{error}</span> : null}
      </span>
    )
  }

  // ready
  return (
    <span className="inline-flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={() => void onShare()}
        className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 text-white px-3.5 py-1.5 text-sm font-medium hover:bg-slate-800 active:bg-slate-950 transition"
      >
        <Share2 size={14} aria-hidden />
        Share PDF
      </button>
      {fallback ? (
        <span className="inline-flex flex-col items-end gap-1">
          <span className="text-xs text-slate-500 max-w-[18rem] text-right">
            Direct sharing isn&rsquo;t available in this browser. Open this app in
            Chrome or Safari to share the PDF directly, or download it:
          </span>
          {objectUrl ? (
            <a
              href={objectUrl}
              download={file?.name}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition"
            >
              <Download size={14} aria-hidden />
              Download PDF
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
