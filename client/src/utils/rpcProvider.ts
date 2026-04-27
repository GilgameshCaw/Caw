import { JsonRpcProvider, WebSocketProvider, Network } from 'ethers'

// ============================================
// GLOBAL RPC THROTTLE
// ============================================
// All providers share a single throttle to stay within per-second rate limits
// (e.g. Infura free tier: 10 req/s). Every send() call goes through this.

/** Minimum ms between consecutive RPC calls across ALL providers. */
const MIN_CALL_GAP_MS = 150

/**
 * Serialized throttle: each caller reserves the NEXT slot in a shared timeline.
 *
 * The previous impl was racy — concurrent callers all read the same
 * `lastCallAt`, all saw enough elapsed time, and all fired in the same tick.
 * `Promise.all([...9 queryFilters])` would submit 9 simultaneous RPC requests,
 * which Infura 429'd en masse (see MarketplaceIndexer:117, ChainSyncService:659).
 *
 * Each caller now bumps nextSlotAt forward by MIN_CALL_GAP_MS and sleeps
 * until its slot — genuinely ≤1 call per gap regardless of concurrency.
 */
let nextSlotAt = 0

async function throttle(): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + MIN_CALL_GAP_MS
  const wait = slot - now
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

// ============================================
// GLOBAL RATE LIMIT BACKOFF
// ============================================
// When any provider hits a 429, ALL providers back off.

let rateLimitedUntil = 0
let backoffMs = 5_000
let consecutiveSuccesses = 0
let consecutiveMaxBackoffs = 0
const MAX_BACKOFF_MS = 60_000
const SUCCESSES_BEFORE_BACKOFF_RESET = 20
// Circuit-breaker: after this many consecutive max-backoff hits, enter a long
// penalty window. Infura escalates to persistent per-key enforcement when it
// sees retry storms, and continuing to hammer during enforcement just prolongs
// the block. 5 minutes of silence is usually enough for enforcement to clear.
const MAX_BACKOFFS_BEFORE_CIRCUIT_OPEN = 3
const CIRCUIT_OPEN_MS = 5 * 60_000

export function recordRateLimit() {
  rateLimitedUntil = Date.now() + backoffMs
  consecutiveSuccesses = 0

  if (backoffMs >= MAX_BACKOFF_MS) {
    consecutiveMaxBackoffs++
    if (consecutiveMaxBackoffs >= MAX_BACKOFFS_BEFORE_CIRCUIT_OPEN) {
      rateLimitedUntil = Date.now() + CIRCUIT_OPEN_MS
      console.warn(`[RPC] ⚠️  Circuit breaker OPEN — pausing ALL RPC traffic for ${CIRCUIT_OPEN_MS / 60_000}min. ` +
        `The RPC provider is persistently rate-limiting us; retrying just prolongs the block. ` +
        `If this keeps firing, rotate your Infura API key or check the dashboard.`)
      consecutiveMaxBackoffs = 0
      return
    }
  }

  console.log(`[RPC] Rate limited — all services backing off for ${(backoffMs / 1000).toFixed(0)}s`)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

// Only reset the backoff floor after a sustained streak of successes.
// Resetting on a single success oscillates 5→10→20→60→5→… as unrelated
// calls succeed briefly in the gaps between rate-limit windows.
export function clearRateLimit() {
  if (backoffMs <= 5_000 && consecutiveMaxBackoffs === 0) return
  consecutiveSuccesses++
  if (consecutiveSuccesses >= SUCCESSES_BEFORE_BACKOFF_RESET) {
    backoffMs = 5_000
    consecutiveSuccesses = 0
    consecutiveMaxBackoffs = 0
  }
}

export function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil
}

export async function waitForRateLimit(): Promise<void> {
  const remaining = rateLimitedUntil - Date.now()
  if (remaining > 0) await new Promise(r => setTimeout(r, remaining))
}

export function isRateLimitError(err: any): boolean {
  const msg = (err?.message || err?.reason || '').toLowerCase()
  const code = err?.error?.code || err?.code
  return code === -32005 || msg.includes('too many requests') || msg.includes('429') || msg.includes('rate limit')
}

// ============================================
// SEND WRAPPER (shared by HTTP + WS providers)
// ============================================

/**
 * Wrap any provider's send() with throttle + rate-limit backoff.
 * This is the single choke point for ALL RPC calls in the process.
 */
function wrapSend<T extends { send: (...args: any[]) => any }>(provider: T): T {
  const originalSend = provider.send.bind(provider)

  provider.send = async function (method: string, params: any[]) {
    // 1. Respect global rate-limit backoff
    if (isRateLimited()) await waitForRateLimit()

    // 2. Throttle: ensure MIN_CALL_GAP_MS between calls
    await throttle()

    try {
      const result = await originalSend(method, params)
      clearRateLimit()
      return result
    } catch (err: any) {
      if (isRateLimitError(err)) recordRateLimit()
      throw err
    }
  } as any

  return provider
}

// ============================================
// URL HELPERS
// ============================================

/**
 * Convert a WebSocket RPC URL to its HTTP equivalent.
 * Handles Infura's /ws/ path segment; safe for other providers.
 */
export function wsToHttp(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/(\.infura\.io)\/ws\/(v\d+\/)/, '$1/$2')
}

export function getL2HttpRpcUrl(fallbackWsUrl?: string): string {
  return withSecret(
    process.env.L2_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L2_RPC_URL || ''),
    process.env.L2_RPC_SECRET,
  )
}

export function getL1HttpRpcUrl(fallbackWsUrl?: string): string {
  return withSecret(
    process.env.L1_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L1_RPC_URL || ''),
    process.env.L1_RPC_SECRET,
  )
}

/** Mainnet RPC for Uniswap price feeds. Honors ETH_MAINNET_RPC_SECRET. */
export function getEthMainnetHttpRpcUrl(fallback?: string): string {
  return withSecret(
    process.env.ETH_MAINNET_RPC_URL || fallback || '',
    process.env.ETH_MAINNET_RPC_SECRET,
  )
}

/** Replication chain RPC. Honors REPLICATION_RPC_SECRET. */
export function getReplicationHttpRpcUrl(fallback?: string): string {
  return withSecret(
    process.env.REPLICATION_RPC || process.env.L2B_RPC_URL || fallback || '',
    process.env.REPLICATION_RPC_SECRET,
  )
}

/**
 * Embed the L2 secret in a WSS URL too. Same /ws/ path adjustment as the
 * HTTP form — Infura accepts Basic Auth in the WebSocket handshake URL.
 */
export function getL2WsRpcUrl(): string {
  return withSecret(process.env.L2_RPC_URL || '', process.env.L2_RPC_SECRET)
}

export function getL1WsRpcUrl(): string {
  return withSecret(process.env.L1_RPC_URL || '', process.env.L1_RPC_SECRET)
}

/**
 * Embed an Infura-style API Key Secret as Basic Auth in the RPC URL.
 * When the operator restricts a provider's project to a domain allowlist
 * (so the frontend bundle can ship the project ID safely), the backend
 * still needs to call that same provider — but it has no Origin header to
 * pass the allowlist. Infura's escape hatch is a per-project "API Key
 * Secret" sent as Basic Auth, which bypasses the origin check.
 *
 * Format produced: `https://:SECRET@host/v3/KEY`. ethers' JsonRpcProvider
 * forwards the userinfo as a Basic Auth header automatically. If the URL
 * already carries userinfo we leave it alone (operator knows what they're
 * doing). Empty / undefined secret is a no-op.
 */
export function withSecret(url: string, secret?: string): string {
  if (!url || !secret) return url
  try {
    const u = new URL(url)
    if (u.username || u.password) return url // already has auth
    u.password = secret
    return u.toString()
  } catch {
    return url
  }
}

// ============================================
// PROVIDER FACTORIES
// ============================================

/**
 * Create a JsonRpcProvider with staticNetwork + throttle.
 * Pass chainId to skip the initial eth_chainId call.
 */
export function makeJsonRpcProvider(url: string, chainId?: number): JsonRpcProvider {
  let provider: JsonRpcProvider
  if (chainId != null) {
    const network = Network.from(chainId)
    provider = new JsonRpcProvider(url, network, { staticNetwork: network })
  } else {
    provider = new JsonRpcProvider(url, undefined, { staticNetwork: true })
  }
  return wrapSend(provider)
}

/**
 * Create a WebSocketProvider with throttle.
 * Pass chainId to skip the initial eth_chainId call.
 */
export function makeWebSocketProvider(url: string, chainId?: number): WebSocketProvider {
  let provider: WebSocketProvider
  if (chainId != null) {
    const network = Network.from(chainId)
    provider = new WebSocketProvider(url, network)
  } else {
    provider = new WebSocketProvider(url)
  }
  return wrapSend(provider)
}
