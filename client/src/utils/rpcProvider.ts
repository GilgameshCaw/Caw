import { JsonRpcProvider, WebSocketProvider, Network } from 'ethers'

// ============================================
// GLOBAL RPC THROTTLE
// ============================================
// All providers share a single throttle to stay within per-second rate limits
// (e.g. Infura free tier: 10 req/s). Every send() call goes through this.

/** Minimum ms between consecutive RPC calls across ALL providers. */
const MIN_CALL_GAP_MS = 150

/** Timestamp of the last RPC call that was sent. */
let lastCallAt = 0

/** Wait until MIN_CALL_GAP_MS has passed since the last call. */
async function throttle(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastCallAt
  if (elapsed < MIN_CALL_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_GAP_MS - elapsed))
  }
  lastCallAt = Date.now()
}

// ============================================
// GLOBAL RATE LIMIT BACKOFF
// ============================================
// When any provider hits a 429, ALL providers back off.

let rateLimitedUntil = 0
let backoffMs = 5_000
const MAX_BACKOFF_MS = 60_000

export function recordRateLimit() {
  rateLimitedUntil = Date.now() + backoffMs
  console.log(`[RPC] Rate limited — all services backing off for ${(backoffMs / 1000).toFixed(0)}s`)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

export function clearRateLimit() {
  if (backoffMs > 5_000) backoffMs = 5_000
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
  return process.env.L2_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L2_RPC_URL || '')
}

export function getL1HttpRpcUrl(fallbackWsUrl?: string): string {
  return process.env.L1_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L1_RPC_URL || '')
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
