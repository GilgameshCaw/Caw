import { JsonRpcProvider, WebSocketProvider, Network, FallbackProvider, AbstractProvider, FetchRequest } from 'ethers'

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
 * Per-URL cache for eth_blockNumber. Every poller in the process calls
 * getBlockNumber() at the top of its tick — RawEventsGatherer (15s),
 * NftTransferWatcher (60s), MarketplaceIndexer (60s), ChainSync L2Events
 * (60s), Validator replication (60s) — all hitting the same RPC. With ~5
 * pollers and a tight throttle, that's still 4-5 redundant calls per
 * 2-second window, every window.
 *
 * This cache collapses identical eth_blockNumber requests into one round
 * trip when they fall within BLOCK_NUMBER_TTL_MS of each other. In-flight
 * dedupe handles concurrent callers (they all await the same Promise);
 * post-resolution caching handles the next-poller case. Keyed by URL so
 * L1 / L2 / mainnet / replication-chain stay separate.
 *
 * Block latency cost: TTL_MS at worst. At 2s with 12s blocks on Base /
 * Arbitrum and 12s on L1, the indexer is at most 2s "stale" — well under
 * one block. Imperceptible to users.
 */
const BLOCK_NUMBER_TTL_MS = 2000
type BlockNumberCacheEntry = { value: any; cachedAt: number; inFlight?: Promise<any> }
const blockNumberCache = new Map<string, BlockNumberCacheEntry>()

function getProviderUrl(provider: any): string | null {
  try {
    // ethers JsonRpcProvider keeps its FetchRequest on _getConnection()
    if (typeof provider._getConnection === 'function') {
      return provider._getConnection().url || null
    }
    // WebSocketProvider — the URL lives on the websocket creator's closure;
    // not introspectable. Fall back to a stable identity (constructor name +
    // network); the cache key just needs to be consistent for one provider.
    return null
  } catch {
    return null
  }
}

/**
 * Wrap a provider's destroy() so we always log who called it. This was
 * load-bearing in the validator-stuck incident: a stale "provider
 * destroyed; cancelled request" surfaced 30s after the destroyer ran,
 * and we couldn't tell from the call-time stack alone where the actual
 * destroy() came from. The wrapped destroy captures and logs the
 * stack at the moment of the call.
 *
 * Idempotent — checks for our own marker so wrapping the same provider
 * twice doesn't double-log.
 */
function wrapDestroy<T extends { destroy?: () => any }>(provider: T): T {
  const p = provider as any
  if (p.__cawDestroyWrapped) return provider
  if (typeof p.destroy !== 'function') return provider
  const original = p.destroy.bind(provider)
  p.destroy = function (...args: any[]) {
    const url = getProviderUrl(provider) || '(no-url)'
    const stack = new Error().stack?.split('\n').slice(2, 8).join('\n  ') || '(no stack)'
    console.warn(`[rpcProvider] destroy() called on ${p.constructor?.name ?? 'Provider'} url=${url}\n  ${stack}`)
    return original(...args)
  }
  p.__cawDestroyWrapped = true
  return provider
}

/**
 * Wrap any provider's send() with throttle + rate-limit backoff.
 * This is the single choke point for ALL RPC calls in the process.
 */
function wrapSend<T extends { send: (...args: any[]) => any; destroy?: () => any }>(provider: T): T {
  // Monkey-patch destroy() first so the stack-trace log fires even on
  // the very first send-then-destroy race.
  wrapDestroy(provider)
  const originalSend = provider.send.bind(provider)
  // Stable per-provider key for the block-number cache. URL when available
  // (HTTP), object identity otherwise (WSS). Either way it dedupes calls
  // through the SAME provider instance — which is what every poller goes
  // through anyway.
  const cacheKey = getProviderUrl(provider) || `provider:${Math.random().toString(36).slice(2)}`

  provider.send = async function (method: string, params: any[]) {
    // Block-number cache: collapse repeated eth_blockNumber calls within
    // BLOCK_NUMBER_TTL_MS into one round trip. Check before the throttle
    // because a cache hit doesn't need a slot.
    if (method === 'eth_blockNumber') {
      const entry = blockNumberCache.get(cacheKey)
      const now = Date.now()
      if (entry) {
        if (entry.inFlight) return entry.inFlight
        if (now - entry.cachedAt < BLOCK_NUMBER_TTL_MS) return entry.value
      }
    }

    // 1. Respect global rate-limit backoff
    if (isRateLimited()) await waitForRateLimit()

    // 2. Throttle: ensure MIN_CALL_GAP_MS between calls
    await throttle()

    let inFlightPromise: Promise<any> | undefined
    if (method === 'eth_blockNumber') {
      inFlightPromise = (async () => {
        try {
          const result = await originalSend(method, params)
          clearRateLimit()
          blockNumberCache.set(cacheKey, { value: result, cachedAt: Date.now() })
          return result
        } catch (err: any) {
          if (isRateLimitError(err)) recordRateLimit()
          // Drop the failed in-flight entry so the next caller can retry.
          blockNumberCache.delete(cacheKey)
          throw err
        }
      })()
      blockNumberCache.set(cacheKey, { value: undefined, cachedAt: 0, inFlight: inFlightPromise })
      return inFlightPromise
    }

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

/**
 * Strip URL-embedded basic auth from a URL and return the bare URL plus
 * the original (URL-decoded) secret. This is the load-bearing helper for
 * fixing the "secret contains `/`" bug:
 *
 *   1. callers historically build URLs with withSecret() — that does
 *      `u.password = secret` which percent-encodes any `/` in the secret.
 *   2. when the URL hits a Basic-Auth-aware fetch layer, the layer
 *      Base64-encodes the percent-ENCODED form (not the raw form) and
 *      Infura rejects it.
 *
 * By extracting the password BEFORE building any HTTP request and routing
 * it via an explicit Authorization header, every code path bypasses the
 * percent-encoding round-trip. We have to decodeURIComponent() it back
 * ourselves — Node's URL.password property returns the percent-ENCODED
 * form, not the raw form (a footgun, since most other URL libraries
 * decode automatically).
 */
function extractEmbeddedAuth(url: string): { cleanUrl: string; secret: string | null } {
  try {
    const u = new URL(url)
    if (!u.password) return { cleanUrl: url, secret: null }
    let secret: string
    try { secret = decodeURIComponent(u.password) }
    catch { secret = u.password } // malformed encoding — best effort
    u.username = ''
    u.password = ''
    return { cleanUrl: u.toString(), secret }
  } catch {
    return { cleanUrl: url, secret: null }
  }
}

/**
 * Build a FetchRequest for the given URL, attaching the operator's RPC
 * secret as a Basic Authorization header if one was either passed
 * explicitly or embedded in the URL.
 *
 * Used by makeJsonRpcProvider so all HTTP RPC calls go through a single
 * code path that handles auth identically to the WebSocket factory.
 */
function buildAuthenticatedFetchRequest(url: string, explicitSecret?: string): FetchRequest {
  const { cleanUrl, secret: embedded } = extractEmbeddedAuth(url)
  const secret = explicitSecret ?? embedded
  const req = new FetchRequest(cleanUrl)
  if (secret) req.setHeader('Authorization', basicAuthHeader(secret))
  return req
}

// ============================================
// PROVIDER FACTORIES
// ============================================

/**
 * Create a JsonRpcProvider with staticNetwork + throttle.
 * Pass chainId to skip the initial eth_chainId call.
 *
 * Auth handling: if the URL has embedded Basic auth (the legacy form
 * produced by withSecret()) OR if `secret` is passed explicitly, we route
 * the credential via an Authorization header on a custom FetchRequest.
 * This bypasses ethers' default URL-based auth handling, which Base64-
 * encodes the URL-ENCODED password — broken for any secret containing
 * a `/`. See extractEmbeddedAuth() for the full explanation.
 */
export function makeJsonRpcProvider(url: string, chainId?: number, secret?: string): JsonRpcProvider {
  const fetchReq = buildAuthenticatedFetchRequest(url, secret)
  let provider: JsonRpcProvider
  if (chainId != null) {
    const network = Network.from(chainId)
    provider = new JsonRpcProvider(fetchReq, network, { staticNetwork: network })
  } else {
    provider = new JsonRpcProvider(fetchReq, undefined, { staticNetwork: true })
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
    // Go through the same FetchRequest-based auth path as the single-URL
    // factory above — otherwise URL-embedded secrets containing `/` break.
    const fetchReq = buildAuthenticatedFetchRequest(url)
    if (network) {
      return new JsonRpcProvider(fetchReq, network, { staticNetwork: network })
    }
    return new JsonRpcProvider(fetchReq, undefined, { staticNetwork: true })
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
  // Detect URL-embedded auth and migrate it to header-based auth — see
  // extractEmbeddedAuth() for why URL-embedded auth breaks for any secret
  // containing a `/`.
  const { cleanUrl, secret: embedded } = extractEmbeddedAuth(url)
  const resolvedSecret = secret ?? embedded

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
