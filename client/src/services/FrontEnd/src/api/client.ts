// src/services/FrontEnd/src/api/client.ts

import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAuthStore } from "~/store/authStore";
import { useVerifyWalletStore } from "~/store/verifyWalletStore";
import { useInstanceStore } from "~/store/instanceStore";

/**
 * natstat: Base URL for all API calls.
 * If set, this is the preferred API host. If empty, instance discovery takes over.
 */
export const API_HOST = import.meta.env.VITE_API_HOST ?? ''

/**
 * Get auth headers for direct fetch calls (e.g., multipart uploads that can't use apiFetch)
 */
export function getAuthHeaders(): Record<string, string> {
  const sessionToken = useAuthStore.getState().sessionToken
  return sessionToken ? { 'x-session-token': sessionToken } : {}
}

/**
 * Custom error for auth failures that need user interaction
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'AUTH_REQUIRED' | 'TOKEN_NOT_AUTHORIZED',
    public tokenId?: number
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Server returned 202 — the data the request needed isn't in the DB yet.
 * Most commonly this happens right after a fresh mint or NFT transfer:
 * the API never falls back to RPC, the indexer (RawEventsGatherer +
 * NftTransferWatcher) populates rows asynchronously, and the client retries.
 *
 * Tier 1 of the "RPC out of API request handlers" refactor — see
 * PROJECT_BACKLOG.md.
 */
export class IndexingError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number
  ) {
    super(message)
    this.name = 'IndexingError'
  }
}

/**
 * Server returned 409 with `error: cawonce_collision`. Two parallel
 * submissions tried to claim the same cawonce slot — caller needs to
 * invalidate its local cawonce watermark, re-read chain, re-sign, and
 * resubmit. Caller code is responsible for that retry; we surface it
 * as a typed error so the wallet sign prompt fires fresh and we don't
 * silently re-submit the old signature.
 */
export class CawonceCollisionError extends Error {
  constructor(message: string, public senderId?: number, public cawonce?: number) {
    super(message)
    this.name = 'CawonceCollisionError'
  }
}

/**
 * Retry an apiFetch (or anything that throws IndexingError) with exponential
 * backoff. Honors the server's retryAfterSeconds hint as the first delay.
 *
 *   const user = await retryOnIndexing(() => apiFetch('/api/users/by-token/1'))
 *
 * Defaults: up to 5 attempts, max 10s between tries. Caps total wait around
 * ~25s — long enough to cover the indexer's worst-case write delay, short
 * enough that a genuinely missing user surfaces a real error to the caller.
 */
export async function retryOnIndexing<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5
  const maxDelayMs = opts.maxDelayMs ?? 10_000
  let attempt = 0
  let lastError: unknown
  while (attempt < maxAttempts) {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof IndexingError)) throw err
      lastError = err
      const hint = err.retryAfterSeconds * 1000
      const backoff = Math.min(hint * Math.pow(2, attempt), maxDelayMs)
      attempt++
      if (attempt >= maxAttempts) break
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  throw lastError
}

/**
 * Build common request headers (auth, user ID, content type)
 */
function buildHeaders(init?: RequestInit): Record<string, string> {
  const state = useTokenDataStore.getState()
  const tokens = Object.values(state.tokensByAddress).flat()
  const activeToken = tokens.find(t => t.tokenId === state.activeTokenId) || tokens[0]
  const activeTokenId = activeToken?.tokenId
  const sessionToken = useAuthStore.getState().sessionToken

  return {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
    ...(activeTokenId !== undefined ? { 'x-user-id': String(activeTokenId) } : {}),
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...(init?.headers as Record<string,string> || {}),
  }
}

/**
 * Handle auth-related response errors (401)
 */
function handleAuthError(_res: Response, errorData: any): never {
  useVerifyWalletStore.getState().show()
  throw new AuthError(
    errorData.message || 'Authentication required',
    errorData.error,
    errorData.tokenId
  )
}

/**
 * natstat: wrapper around fetch that prefixes our API host.
 * Supports multi-instance failover: tries each known API host in order.
 * Falls back to VITE_API_HOST if no instances are discovered.
 */
export async function apiFetch<T = any>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = buildHeaders(init)

  // Get ordered list of API hosts, filtered by trust score
  const { useHostVerificationStore } = await import('~/hooks/useHostVerification')
  const verificationStore = useHostVerificationStore.getState()

  const hosts = useInstanceStore.getState().getApiHosts()
    .filter((h: string) => !verificationStore.isBlacklisted(h))
    .sort((a: string, b: string) => verificationStore.getHostScore(a) - verificationStore.getHostScore(b))

  // If no discovered instances, fall back to API_HOST (may be empty for dev proxy)
  const targets = hosts.length > 0 ? hosts : [API_HOST]

  let lastError: Error | null = null

  for (const host of targets) {
    try {
      const startTime = Date.now()
      const url = `${host}${path}`
      const res = await fetch(url, {
        credentials: 'include', // admin HttpOnly cookie needs this; session-token header is unaffected
        ...init,
        headers,
      })

      // Track response time for host ranking
      verificationStore.recordResponseTime(host, Date.now() - startTime)

      // 202 = "still indexing" — the row isn't in the DB yet. The API never
      // falls back to RPC; the indexer populates asynchronously and the
      // caller retries. Throw IndexingError so React Query / retryOnIndexing
      // can back off without us losing the retry hint.
      if (res.status === 202) {
        let data: any = {}
        try { data = await res.json() } catch {}
        const retryAfterHeader = Number(res.headers.get('Retry-After')) || 0
        const retryAfter = Number(data?.retryAfterSeconds) || retryAfterHeader || 3
        throw new IndexingError(data?.error || 'still indexing', retryAfter)
      }

      // 409 with cawonce_collision = the TxQueue partial unique index on
      // (senderId, cawonce) for active rows fired. Two near-simultaneous
      // signs picked the same chain-nextCawonce; the second one to insert
      // gets caught here. Throw the typed error so the caller (signAndSubmit)
      // can invalidate its local watermark, re-read chain, and re-sign.
      // Don't failover — every instance has the same partial index, and
      // the cawonce really is taken.
      if (res.status === 409) {
        let data: any = {}
        try { data = await res.json() } catch {}
        if (data?.error === 'cawonce_collision') {
          throw new CawonceCollisionError(
            data?.message || 'cawonce already in use',
            data?.senderId,
            data?.cawonce,
          )
        }
        // Other 409s are different conflict shapes (e.g. retry-already-submitted);
        // fall through to the generic !res.ok handler below.
      }

      // Auth errors are not failover-able — they mean the user needs to re-auth
      if (res.status === 401) {
        let errorData: any = {}
        try { errorData = await res.json() } catch {}
        if (errorData.error === 'AUTH_REQUIRED') {
          // Session expired or missing server-side — clear stale client state
          useAuthStore.getState().clearSession()
        }
        const method = (init?.method || 'GET').toUpperCase()
        if (method !== 'GET' && (errorData.error === 'AUTH_REQUIRED' || errorData.error === 'TOKEN_NOT_AUTHORIZED')) {
          // Don't show verify modal if Quick Sign is active — the next Quick Sign
          // action will passively establish the HTTP session for this token's owner.
          const { useSessionKeyStore } = await import('~/store/sessionKeyStore')
          const sessionStore = useSessionKeyStore.getState()
          const hasQuickSign = sessionStore.enabled && Object.values(sessionStore.sessions).some(
            s => s && s.expiry > Date.now() / 1000
          )
          if (!hasQuickSign) {
            handleAuthError(res, errorData)
          }
        }
      }

      // Client errors (4xx) are not the instance's fault — don't failover
      // Server errors (5xx) mean this instance is unhealthy — try the next one
      if (res.status >= 500) {
        lastError = new Error(`API ${res.status} ${res.statusText}`)
        continue
      }

      if (!res.ok) {
        let detail = ''
        try {
          const body = await res.json()
          detail = body?.error || body?.message || ''
        } catch {}
        throw new Error(detail ? `API ${res.status}: ${detail}` : `API ${res.status} ${res.statusText}`)
      }

      // Track which host we're actively using
      useInstanceStore.getState().setActiveApiHost(host)

      return res.json()
    } catch (e: any) {
      // Network errors (ECONNREFUSED, timeout, etc.) — try next instance
      if (e instanceof AuthError) throw e
      // 202 means this instance has authoritative state (its DB just hasn't
      // caught up yet) — failing over to another instance doesn't help and
      // would mask the indexing-in-progress signal from the caller.
      if (e instanceof IndexingError) throw e
      // 409 cawonce_collision — every instance has the same active-cawonce
      // unique index, and (more importantly) the cawonce really is taken.
      // Failover would just re-collide; surface to the caller for re-sign.
      if (e instanceof CawonceCollisionError) throw e
      lastError = e
      if (targets.length > 1) {
        console.warn(`[apiFetch] Instance ${host} failed, trying next...`, e.message)
      }
      continue
    }
  }

  throw lastError ?? new Error('No API instances available')
}
