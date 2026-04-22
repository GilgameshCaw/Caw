import { JsonRpcProvider, WebSocketProvider, Network } from 'ethers'

// ============================================
// GLOBAL RATE LIMIT BACKOFF
// ============================================
// When any service hits a 429, ALL services back off to avoid making it worse.
// Shared across the process — every service checks this before making RPC calls.

let rateLimitedUntil = 0
let backoffMs = 5_000 // starts at 5s, doubles on each consecutive 429, caps at 60s
const MAX_BACKOFF_MS = 60_000

/**
 * Record that a 429 rate limit was hit. All services should call this
 * when they detect a rate-limit error from the RPC.
 */
export function recordRateLimit() {
  rateLimitedUntil = Date.now() + backoffMs
  console.log(`[RPC] Rate limited — all services backing off for ${(backoffMs / 1000).toFixed(0)}s`)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

/**
 * Clear the backoff after a successful RPC call.
 */
export function clearRateLimit() {
  if (backoffMs > 5_000) {
    backoffMs = 5_000
  }
}

/**
 * Check if we're currently in a rate-limit backoff period.
 * Services should call this before making RPC requests and skip/delay if true.
 */
export function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil
}

/**
 * Wait until the rate limit backoff period has passed.
 * Returns immediately if not rate limited.
 */
export async function waitForRateLimit(): Promise<void> {
  const remaining = rateLimitedUntil - Date.now()
  if (remaining > 0) {
    await new Promise(r => setTimeout(r, remaining))
  }
}

/**
 * Check if an error is a rate-limit (429) error from the RPC provider.
 */
export function isRateLimitError(err: any): boolean {
  const msg = (err?.message || err?.reason || '').toLowerCase()
  const code = err?.error?.code || err?.code
  return code === -32005 || msg.includes('too many requests') || msg.includes('429') || msg.includes('rate limit')
}

/**
 * Convert a WebSocket RPC URL to its HTTP equivalent. Prefer using an
 * explicit HTTP URL from env vars (L2_RPC_URL_HTTP, L1_RPC_URL_HTTP)
 * when available — this is a best-effort fallback.
 *
 * Handles two transformations:
 * 1. Scheme swap: wss→https, ws→http (safe for all providers)
 * 2. Infura path: strips the `/ws/` segment that Infura inserts between
 *    host and API key in their WebSocket URLs. Only applied when the URL
 *    matches the Infura pattern (*.infura.io/ws/v3/...) so it won't
 *    corrupt URLs from other providers.
 */
export function wsToHttp(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/(\.infura\.io)\/ws\/(v\d+\/)/, '$1/$2')
}

/**
 * Get the HTTP RPC URL for L2, preferring the explicit env var.
 */
export function getL2HttpRpcUrl(fallbackWsUrl?: string): string {
  return process.env.L2_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L2_RPC_URL || '')
}

/**
 * Get the HTTP RPC URL for L1, preferring the explicit env var.
 */
export function getL1HttpRpcUrl(fallbackWsUrl?: string): string {
  return process.env.L1_RPC_URL_HTTP || wsToHttp(fallbackWsUrl || process.env.L1_RPC_URL || '')
}

/**
 * Create a JsonRpcProvider with `staticNetwork: true` so ethers skips its
 * internal "_detectNetwork" retry loop. Without staticNetwork, when the RPC
 * is unreachable ethers spams `JsonRpcProvider failed to detect network; retry
 * in 1s` forever — once per provider per second. We have ~8 long-lived
 * provider instances across services, so during a network outage the logs
 * get flooded with hundreds of lines per minute from ethers internals.
 *
 * With staticNetwork, the provider waits for the first real send() call to
 * establish the network and then locks it in. Failed sends surface as normal
 * timeouts in the caller's retry/backoff, which we control and can log once
 * per cycle instead of per second.
 *
 * If `chainId` is known up front, pass it so the provider is usable even
 * before the first successful RPC call.
 */
export function makeJsonRpcProvider(url: string, chainId?: number): JsonRpcProvider {
  let provider: JsonRpcProvider
  if (chainId != null) {
    const network = Network.from(chainId)
    provider = new JsonRpcProvider(url, network, { staticNetwork: network })
  } else {
    provider = new JsonRpcProvider(url, undefined, { staticNetwork: true })
  }
  return wrapProviderWithRateLimit(provider)
}

/**
 * Create a WebSocketProvider with rate-limit awareness.
 *
 * If `chainId` is known, pass it so the provider skips the initial
 * eth_chainId call (one less request on connect).
 *
 * The provider's internal send() is wrapped to respect the global
 * rate-limit backoff, same as JsonRpcProvider.
 */
export function makeWebSocketProvider(url: string, chainId?: number): WebSocketProvider {
  let provider: WebSocketProvider
  if (chainId != null) {
    const network = Network.from(chainId)
    provider = new WebSocketProvider(url, network)
  } else {
    provider = new WebSocketProvider(url)
  }

  // Wrap send() to respect global rate limit (same as HTTP providers)
  const originalSend = provider.send.bind(provider)
  provider.send = async function(method: string, params: any[]) {
    if (isRateLimited()) {
      await waitForRateLimit()
    }
    try {
      const result = await originalSend(method, params)
      clearRateLimit()
      return result
    } catch (err: any) {
      if (isRateLimitError(err)) {
        recordRateLimit()
      }
      throw err
    }
  } as any

  return provider
}

/**
 * Wrap a JsonRpcProvider to automatically handle rate limits.
 * Intercepts the internal send() method to:
 * 1. Wait if we're in a global rate-limit backoff
 * 2. Record 429 errors and trigger backoff
 * 3. Clear backoff on success
 */
function wrapProviderWithRateLimit<T extends JsonRpcProvider>(provider: T): T {
  const originalSend = provider.send.bind(provider)

  provider.send = async function(method: string, params: any[]) {
    // Wait if globally rate-limited
    if (isRateLimited()) {
      await waitForRateLimit()
    }

    try {
      const result = await originalSend(method, params)
      clearRateLimit()
      return result
    } catch (err: any) {
      if (isRateLimitError(err)) {
        recordRateLimit()
      }
      throw err
    }
  } as any

  return provider
}
