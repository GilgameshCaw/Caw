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
  constructor(
    message: string,
    public senderId?: number,
    public cawonce?: number,
    /** Server-suggested next cawonce: max(active TxQueue cawonces) + 1 for
     *  this sender. Use as a floor on the retry — the chain alone won't
     *  know about cawonces still in our own TxQueue. */
    public suggestedCawonce?: number,
  ) {
    super(message)
    this.name = 'CawonceCollisionError'
  }
}

/** Thrown by apiFetch on HTTP 410 from /api/caws/:id when the caw was
 *  hidden by its author. Distinct from a 404 (which is "doesn't exist or
 *  not visible") so the caller can render a "removed by author"
 *  tombstone with the author's handle attached. */
export class RemovedCawError extends Error {
  constructor(
    message: string,
    public author: string | null,
  ) {
    super(message)
    this.name = 'RemovedCawError'
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

  // Build-time git SHA. Stamped on every request so the API can persist it
  // alongside TxQueue rows — when something fails (e.g. a stale FE racing
  // a recent fix), we can tell which build produced the bad action without
  // guessing.
  const clientVersion = (typeof __CLIENT_VERSION__ !== 'undefined' && __CLIENT_VERSION__)
    || 'unknown'

  return {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
    'x-caw-client-version': clientVersion,
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

  // Single-host: apiFetch always targets THIS install's API. The user's
  // session, auth state, optimistic rows, and per-install settings all
  // live on the home node — fanning out to peers returns either CORS
  // failures (peer rejects the cross-origin authenticated read) or the
  // wrong server's data (peer returns its own state for what looks like
  // the same path). Cross-instance fan-out only makes sense for
  // redundancy broadcasts (signAndSubmit) and public-read peer queries
  // (instance registry); those have their own iteration code paths.
  //
  // Precedence: explicit activeApiHost (set after a successful round-trip
  // — preserves stickiness through transient failures) → VITE_API_HOST →
  // empty string (relative URL → vite dev proxy in dev, same-origin in
  // production behind nginx). Per project_multi_instance_apifetch.md the
  // empty-string default routes to the local proxy when the FE is
  // localhost without a configured API host.
  const host =
    useInstanceStore.getState().activeApiHost ??
    API_HOST ??
    ''

  const url = `${host}${path}`
  const res = await fetch(url, {
    credentials: 'include', // admin HttpOnly cookie needs this; session-token header is unaffected
    ...init,
    headers,
  })

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
  if (res.status === 409) {
    let data: any = {}
    try { data = await res.json() } catch {}
    if (data?.error === 'cawonce_collision') {
      throw new CawonceCollisionError(
        data?.message || 'cawonce already in use',
        data?.senderId,
        data?.cawonce,
        typeof data?.suggestedCawonce === 'number' ? data.suggestedCawonce : undefined,
      )
    }
    // Other 409s are different conflict shapes (e.g. retry-already-submitted);
    // fall through to the generic !res.ok handler below.
  }

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

  if (!res.ok) {
    let body: any = {}
    let detail = ''
    try {
      body = await res.json()
      detail = body?.error || body?.message || ''
    } catch {}

    // 410 Gone — currently emitted by /api/caws/:id when the caw was
    // hidden by its author. Throw a typed error so CawPage can render a
    // tombstone instead of the generic "Could not load post" path.
    if (res.status === 410 && body?.removed) {
      throw new RemovedCawError(
        detail || 'caw removed by author',
        typeof body.author === 'string' ? body.author : null,
      )
    }

    throw new Error(detail ? `API ${res.status}: ${detail}` : `API ${res.status} ${res.statusText}`)
  }

  // Pin the active host for subsequent calls so the FE stays sticky on the
  // node that just answered (matters once we add real failover at a higher
  // layer; today this just preserves the current host across re-renders).
  useInstanceStore.getState().setActiveApiHost(host)

  return res.json()
}
