/**
 * useXSignupVerification — session-less X OAuth for the open sponsored-signup
 * gate. Mirrors AccountSettings' account-LINKING popup mechanics (same
 * audit-fixed popup / mobile-redirect / storage-event / pageshow handling) but
 * targets the pre-account endpoints (/api/verify/x/signup-*) and reads the
 * signup-specific localStorage key so it never collides with the link flow.
 *
 * On success the callback resolves to { qualified, token?, xHandle?, reason? }.
 * The caller stores `token` and passes it to bootstrapNewUser as the gate
 * (instead of an invite code). See messages/open-sponsored-flow-design.md.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch, API_HOST } from '~/api/client'

const STORAGE_KEY = 'caw:xsignup:result'
const PENDING_KEY = 'caw:xsignup:pending'

export interface XSignupResult {
  ok: boolean
  qualified?: boolean
  token?: string
  xHandle?: string
  /** When qualified === false: 'not_qualified' | 'x_account_already_used'. */
  reason?: string
  error?: string
}

function getSignupRedirectUri(): string {
  const base = (API_HOST || window.location.origin).replace(/\/+$/, '')
  return `${base}/api/verify/x/signup-callback`
}

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const isNarrow = window.innerWidth < 768
  return hasTouch && isNarrow
}

export function useXSignupVerification() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<XSignupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Listen for the callback's localStorage write (popup desktop path) and the
  // bfcache/pageshow return (mobile redirect path).
  useEffect(() => {
    const consume = (raw: string | null) => {
      if (!raw) return
      let env: any
      try { env = JSON.parse(raw) } catch { return }
      if (env?.source !== 'caw-xverify' || !env?.payload) return
      // Clear BEFORE acting so we never re-fire on a stale value.
      try { localStorage.removeItem(STORAGE_KEY) } catch {}
      try { localStorage.removeItem(PENDING_KEY) } catch {}
      setBusy(false)
      const p = env.payload as XSignupResult
      setResult(p)
      if (!p.ok) setError(p.error || 'x_verification_failed')
      else setError(null)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      consume(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    consume(typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null)

    const onPageShow = () => {
      const hasPending = typeof localStorage !== 'undefined' && !!localStorage.getItem(PENDING_KEY)
      const hasResult  = typeof localStorage !== 'undefined' && !!localStorage.getItem(STORAGE_KEY)
      if (hasPending || hasResult) {
        setBusy(true)
        consume(typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null)
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  const start = useCallback(() => {
    setBusy(true)
    setError(null)
    setResult(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch {}

    const isStandalone = typeof window !== 'undefined' &&
      window.matchMedia('(display-mode: standalone)').matches
    const isMobile = isMobileDevice() || isStandalone
    if (isMobile) {
      try { localStorage.setItem(PENDING_KEY, '1') } catch {}
    }

    let popup: Window | null = null
    if (!isMobile) {
      // Open synchronously inside the click gesture (Safari popup-blocker).
      popup = window.open('about:blank', 'caw-xsignup', 'width=600,height=700')
      if (!popup) {
        setBusy(false)
        setError('Popup was blocked. Allow popups for this site and try again.')
        return
      }
      try {
        popup.document.write(
          '<!doctype html><meta charset="utf-8"><title>Connecting to X…</title>' +
          '<style>body{font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#000;color:#fff}</style>' +
          '<div>Connecting to X…</div>'
        )
      } catch { /* cross-origin doc.write can throw; harmless */ }
    }

    apiFetch<{ url: string }>('/api/verify/x/signup-start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        redirectUri: getSignupRedirectUri(),
        ...(isMobile ? { returnTo: window.location.href } : {}),
      }),
    })
      .then((res) => {
        // Validate the OAuth origin (defense against a compromised node turning
        // this into an open redirect). Mirrors the link flow's audit fix.
        const X_OAUTH_ORIGINS = new Set(['https://x.com', 'https://twitter.com', 'https://api.x.com', 'https://api.twitter.com'])
        let target: URL
        try { target = new URL(res.url) } catch {
          setBusy(false); setError('Invalid X OAuth response. Please try again.'); return
        }
        if (!X_OAUTH_ORIGINS.has(target.origin)) {
          setBusy(false); setError(`X OAuth URL has unexpected origin: ${target.origin}`); return
        }
        if (isMobile) { window.location.href = res.url; return }
        try { popup!.location.href = res.url } catch {
          setBusy(false); setError('Popup was closed before connecting. Please try again.'); return
        }
        // Busy-state timeout so the button isn't stuck if the user abandons.
        setTimeout(() => setBusy(prev => prev ? false : prev), 90_000)
      })
      .catch((e) => {
        setBusy(false)
        try { popup?.close() } catch {}
        setError(e?.message || 'Failed to start X verification')
      })
  }, [])

  const reset = useCallback(() => { setResult(null); setError(null); setBusy(false) }, [])

  return { start, busy, result, error, reset }
}
