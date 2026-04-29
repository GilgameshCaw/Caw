import { JsonRpcProvider, WebSocketProvider, Network, FallbackProvider, AbstractProvider } from 'ethers'

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

/**
 * Return the L2 HTTP URL plus any operator-configured fallback URLs.
 * Fallbacks come from L2_RPC_URL_HTTP_FALLBACK as a comma-separated list,
 * and each gets the matching secret from L2_RPC_SECRET_FALLBACK (also
 * comma-separated, positionally aligned with the URL list — empty entries
 * are fine).
 *
 * Returns at minimum [primary]. The array is the input to
 * makeFallbackJsonRpcProvider — when the validator's primary RPC starts
 * timing out, ethers' FallbackProvider rotates to the next one.
 */
export function getL2HttpRpcUrls(fallbackWsUrl?: string): string[] {
  const primary = getL2HttpRpcUrl(fallbackWsUrl)
  const extraRaw = process.env.L2_RPC_URL_HTTP_FALLBACK || ''
  const secretRaw = process.env.L2_RPC_SECRET_FALLBACK || ''
  if (!extraRaw.trim()) return primary ? [primary] : []
  const extras = extraRaw.split(',').map(s => s.trim()).filter(Boolean)
  const secrets = secretRaw.split(',').map(s => s.trim())
  const withAuth = extras.map((u, i) => withSecret(u, secrets[i] || undefined))
  return primary ? [primary, ...withAuth] : withAuth
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
 * L2 / L1 WSS endpoint. We DO NOT embed the secret here — see the warning
 * on withSecret() about percent-encoded `/`. Callers should hand the bare
 * URL and the raw secret separately to makeWebSocketProvider, which routes
 * the secret via an Authorization header.
 *
 * The legacy form (URL-embedded auth) is still returned by withSecret()
 * for callers that haven't migrated yet — those keep working as long as
 * the secret has no `/` in it. New code should pass the secret via the
 * provider factory's `secret` parameter.
 */
export function getL2WsRpcUrl(): string {
  return process.env.L2_RPC_URL || ''
}

export function getL1WsRpcUrl(): string {
  return process.env.L1_RPC_URL || ''
}

export function getL1WsSecret(): string | undefined {
  return process.env.L1_RPC_SECRET || undefined
}

export function getL2WsSecret(): string | undefined {
  return process.env.L2_RPC_SECRET || undefined
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
 *
 * BEWARE: when `secret` contains a `/`, URL serialization percent-encodes
 * it to `%2F`. The ws / fetch implementations then Base64-encode the
 * encoded form, which Infura rejects with 401 ("project secret is
 * invalid") because it's expecting the raw secret in the Basic Auth
 * blob. JsonRpcProvider over HTTPS happens to handle this correctly via
 * Node's `URL`-aware http client, but `WebSocketProvider` does not —
 * use makeWebSocketProvider directly with L1_RPC_URL + L1_RPC_SECRET
 * and it'll route the secret via an explicit Authorization header.
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

/**
 * Build a Basic Auth header value for a project-secret-style credential.
 * Infura uses an empty username + the secret in the password slot. We
 * Base64-encode the raw secret here (NOT a URL-encoded form), which is
 * what every server expects.
 */
function basicAuthHeader(secret: string): string {
  return 'Basic ' + Buffer.from(':' + secret).toString('base64')
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
 * Create a provider that fans out across multiple HTTP RPC URLs and routes
 * around dead/flaky ones. With a single URL, returns a plain JsonRpcProvider
 * (no quorum overhead). With 2+ URLs, returns a FallbackProvider — ethers
 * will retry against the next provider when one times out / errors.
 *
 * Type erased to AbstractProvider because FallbackProvider and JsonRpcProvider
 * both extend it; call sites that need JsonRpcProvider-specific APIs (rare —
 * almost everything we use is on the AbstractProvider interface) should keep
 * using makeJsonRpcProvider with a single URL.
 *
 * Quorum: 1 — accept the first non-error response. This is the right setting
 * for "operator wants resilience, not consensus." If the operator wants
 * quorum-style consensus across two providers (e.g. to defend against
 * malicious RPC responses), they can configure that later — the protocol's
 * trust model places that responsibility on the on-chain simulation, not
 * the RPC layer.
 */
export function makeFallbackJsonRpcProvider(urls: string[], chainId?: number): AbstractProvider {
  if (urls.length === 0) throw new Error('makeFallbackJsonRpcProvider: no URLs provided')
  if (urls.length === 1) return makeJsonRpcProvider(urls[0], chainId)
  const network = chainId != null ? Network.from(chainId) : undefined
  const subproviders = urls.map(url => {
    if (network) {
      return new JsonRpcProvider(url, network, { staticNetwork: network })
    }
    return new JsonRpcProvider(url, undefined, { staticNetwork: true })
  })
  // Each subprovider gets equal weight; quorum 1 = first-success-wins.
  // The 'priority' field defaults to 1 across configs, so all candidates
  // are tried in order on each request. ethers internally rotates failing
  // providers out of the active set after a few errors.
  const configs = subproviders.map(provider => ({ provider, weight: 1 }))
  const fallback = new FallbackProvider(configs, network, { quorum: 1 })
  // wrapSend hooks the throttle into .send(); FallbackProvider itself
  // doesn't expose .send() the same way, so throttle applies on each
  // subprovider's individual calls instead.
  for (const sp of subproviders) wrapSend(sp)
  return fallback
}

/**
 * Create a WebSocketProvider with throttle.
 * Pass chainId to skip the initial eth_chainId call.
 *
 * If `secret` is provided we route it via an explicit Authorization
 * header rather than embedding in the URL — see the warning on
 * withSecret() for why URL-embedding breaks for any secret containing
 * a `/`. The function builds its own ws.WebSocket and hands ethers a
 * thunk that returns it.
 */
export function makeWebSocketProvider(url: string, chainId?: number, secret?: string): WebSocketProvider {
  // Detect URL-embedded auth and migrate it to header-based auth. This
  // fixes the percent-encoding round-trip bug where a `/` in the secret
  // gets URL-encoded as `%2F`, then Base64-encoded by the ws library —
  // Infura then decodes Base64 and rejects the encoded form as invalid.
  // By extracting userinfo here and routing it via Authorization header,
  // every existing caller (including ones using withSecret() URLs) gets
  // the fix automatically without API changes.
  let cleanUrl = url
  let resolvedSecret = secret
  try {
    const u = new URL(url)
    if (u.password && !resolvedSecret) {
      // password was URL-decoded by the URL parser, so this gives us the
      // original raw secret — exactly what we need for the auth header.
      resolvedSecret = u.password
    }
    if (u.password || u.username) {
      u.username = ''
      u.password = ''
      cleanUrl = u.toString()
    }
  } catch {
    // Invalid URL — fall through; ethers will surface the error.
  }

  let provider: WebSocketProvider
  if (resolvedSecret) {
    const headers = { Authorization: basicAuthHeader(resolvedSecret) }
    // ethers v6 accepts a WebSocketCreator: a thunk returning a
    // WebSocketLike. Construct ws.WebSocket(url, options) directly so the
    // Authorization header lands on the upgrade request.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WebSocketImpl = require('ws')
    const creator = () => new WebSocketImpl(cleanUrl, { headers }) as any
    if (chainId != null) {
      const network = Network.from(chainId)
      provider = new WebSocketProvider(creator, network)
    } else {
      provider = new WebSocketProvider(creator)
    }
  } else {
    if (chainId != null) {
      const network = Network.from(chainId)
      provider = new WebSocketProvider(cleanUrl, network)
    } else {
      provider = new WebSocketProvider(cleanUrl)
    }
  }
  return wrapSend(provider)
}
