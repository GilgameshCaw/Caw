import { Router, Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getL1HttpRpcUrls,
  getL2HttpRpcUrls,
} from '../../utils/rpcProvider'
import { originGate } from '../middleware/originGate'
import * as ADDR from '../../abi/addresses'

// ─────────────────────────────────────────────────────────────────
// Method + target-contract allowlist
// ─────────────────────────────────────────────────────────────────
// The proxy is unauthenticated by design (it serves not-yet-signed-in users
// browsing the app), and the origin gate only stops browsers — a script can
// spoof the Origin header. So a scraper could use /api/rpc/* as a free personal
// RPC against our paid Infura key. We tighten it HERE (not on the Infura side) so
// every mirror inherits the same policy from the code and gets a clean JSON-RPC
// error instead of an opaque upstream rejection.
//
// Two gates:
//   1. METHOD allowlist — only the read/tx methods the FE actually uses. Blocks
//      the expensive/abusable ones (debug_*, trace_*, eth_subscribe, admin_*,
//      archive-heavy calls) outright.
//   2. TARGET-CONTRACT allowlist — for address-targeting reads (eth_call,
//      eth_getLogs, eth_getStorageAt, eth_getCode), the target must be one of
//      OUR contracts (or a token/pool/router we read for prices). Calls to an
//      UNKNOWN address are allowed-but-logged by default (so the operator sees
//      scrape attempts) and BLOCKED when RPC_PROXY_STRICT=1 — EXCEPT that
//      passkey/ERC-1271 reads legitimately target arbitrary user EOAs, which we
//      can't enumerate, so unknown targets aren't hard-blocked without the flag.

const ALLOWED_METHODS = new Set<string>([
  // Reads
  'eth_call', 'eth_getLogs', 'eth_getStorageAt', 'eth_getCode', 'eth_getBalance',
  'eth_blockNumber', 'eth_chainId', 'net_version', 'eth_gasPrice',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_feeHistory',
  'eth_maxPriorityFeePerGas', 'eth_getTransactionCount',
  // Tx lifecycle (wallet flows)
  'eth_estimateGas', 'eth_sendRawTransaction',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  // web3 handshake
  'web3_clientVersion',
])

// Every contract we legitimately read through the proxy. Built from addresses.ts
// so each mirror's own deploy is covered automatically; operators can append
// extras via RPC_PROXY_EXTRA_CONTRACTS (comma-separated).
const KNOWN_CONTRACTS: Set<string> = (() => {
  const s = new Set<string>()
  for (const [k, v] of Object.entries(ADDR)) {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && k.endsWith('ADDRESS')) {
      s.add(v.toLowerCase())
    }
  }
  // Uniswap V2 router (mainnet price reads) — not in addresses.ts as an *_ADDRESS.
  s.add('0x7a250d5630b4cf539739df2c5dacb4c659f2488d')
  for (const raw of (process.env.RPC_PROXY_EXTRA_CONTRACTS || '').split(',')) {
    const a = raw.trim().toLowerCase()
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) s.add(a)
  }
  return s
})()

const RPC_PROXY_STRICT = process.env.RPC_PROXY_STRICT === '1'

// Pull the target address out of an address-targeting read's params.
function targetAddressOf(method: string, params: unknown): string | null {
  if (!Array.isArray(params) || params.length === 0) return null
  const p0 = params[0] as any
  if (method === 'eth_call' || method === 'eth_estimateGas') {
    return typeof p0?.to === 'string' ? p0.to.toLowerCase() : null
  }
  if (method === 'eth_getStorageAt' || method === 'eth_getCode' || method === 'eth_getBalance') {
    return typeof p0 === 'string' ? p0.toLowerCase() : null
  }
  if (method === 'eth_getLogs') {
    const addr = p0?.address
    if (typeof addr === 'string') return addr.toLowerCase()
    if (Array.isArray(addr) && typeof addr[0] === 'string') return addr[0].toLowerCase()
  }
  return null
}

// Decide whether a single JSON-RPC call is permitted. Returns null if allowed,
// or a JSON-RPC error body if blocked.
function screenCall(call: any): any | null {
  const { method, params, id } = call
  if (!ALLOWED_METHODS.has(method)) {
    // Soft by default so a method viem uses that we didn't list can't blank the
    // app on deploy — log it (operator adds it to ALLOWED_METHODS or sees abuse)
    // and only hard-block under RPC_PROXY_STRICT. Flip strict on once the live
    // method set is confirmed from logs.
    if (RPC_PROXY_STRICT) {
      console.warn(`[rpc-proxy] STRICT blocked method: ${method}`)
      return jsonRpcError(id, -32601, `Method not allowed: ${method}`)
    }
    console.warn(`[rpc-proxy] non-allowlisted method: ${method} (allowed; set RPC_PROXY_STRICT=1 to block)`)
    return null
  }
  // Address-gated reads. eth_getBalance/eth_estimateGas target EOAs freely — no
  // contract gate. eth_call/getLogs/getStorageAt/getCode target contracts.
  if (method === 'eth_call' || method === 'eth_getLogs' ||
      method === 'eth_getStorageAt' || method === 'eth_getCode') {
    const to = targetAddressOf(method, params)
    if (to && !KNOWN_CONTRACTS.has(to)) {
      // Unknown target: could be a user EOA (passkey/ERC-1271 read — legit) or a
      // scrape of some other contract. We can't cheaply tell without a getCode,
      // so log it, and only hard-block under RPC_PROXY_STRICT (mainnet opt-in).
      if (RPC_PROXY_STRICT) {
        console.warn(`[rpc-proxy] STRICT blocked ${method} → unknown target ${to}`)
        return jsonRpcError(id, -32601, 'Target contract not allowed')
      }
      console.warn(`[rpc-proxy] ${method} → non-allowlisted target ${to} (allowed; set RPC_PROXY_STRICT=1 to block)`)
    }
  }
  return null
}

/**
 * FE → backend → upstream RPC proxy.
 *
 * The FE used to talk to Infura directly, which meant every browser tab
 * counted toward our daily quota independently and we couldn't dedupe
 * identical reads across users. This proxy forwards JSON-RPC bodies to
 * our paid RPC, with two key optimizations layered on top:
 *
 *   1. In-flight request coalescing. If two users (or two tabs) fire
 *      the exact same eth_call within milliseconds, we issue ONE
 *      upstream request and reply to both with the same body.
 *
 *   2. Short-TTL response cache for "latest"-block reads. eth_call,
 *      eth_getBalance, eth_blockNumber, eth_getCode etc. against the
 *      latest block share results across all callers for a few seconds.
 *      Reads against a pinned block hash/number bypass the cache (they
 *      can be cached indefinitely if we wanted, but the upstream is
 *      fast for them and the FE rarely re-asks). State-changing methods
 *      (eth_sendRawTransaction, eth_subscribe, etc.) always pass through.
 *
 * The upstream URL + secret comes from the backend's existing
 * L1_RPC_URL_HTTP / L2_RPC_URL_HTTP + matching _SECRET vars via the
 * project's withSecret embedding. We extract the secret here so the
 * outgoing fetch uses an Authorization header — Infura's path
 * matching otherwise rejects percent-encoded secrets per the long
 * comment in rpcProvider.ts.
 */

const router = Router()

// Origin gate lives in middleware/originGate.ts so other proxy routes
// (ai-proxy, etc.) can share it. See that file for the allowlist semantics.
// The gate is a factory — we pass our own JSON-RPC response body so the
// shape stays exactly what RPC clients have always received here.
const gate = originGate(() => ({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32001, message: 'RPC proxy: origin not allowed' },
}))

// Per-IP rate limit. Catches a single browser misbehaving without
// affecting other users. Set generously: a normal user's tab fires
// ~10 RPCs/min after our optimizations; a bot/buggy tab firing 100/sec
// gets cut off here instead of blowing through Infura.
const proxyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600, // 10/sec sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: -32005, message: 'RPC proxy: rate limited' } },
})

// ─────────────────────────────────────────────────────────────────
// Response cache + in-flight dedup
// ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number
  body: any
}
type Chain = 'l1' | 'l2'

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<any>>()

// Methods we feel safe caching. Each value is the TTL in ms for a
// "latest"-block read; pinned-block reads use the LONG_TTL.
const CACHEABLE_LATEST_MS: Record<string, number> = {
  eth_call:                   3_000,
  eth_getBalance:             3_000,
  eth_getCode:                30_000,
  eth_getStorageAt:           3_000,
  eth_blockNumber:            5_000,
  eth_gasPrice:               5_000,
  eth_chainId:                3_600_000, // chainId is immutable
  net_version:                3_600_000,
  eth_getLogs:                5_000,
}

const LONG_TTL_MS = 5 * 60 * 1000 // pinned-block reads

function cacheKey(chain: Chain, method: string, params: unknown): string {
  // JSON.stringify the params verbatim — order matters for eth_call's
  // tx object but every honest client uses the canonical order.
  return `${chain}:${method}:${JSON.stringify(params ?? null)}`
}

function isLatestBlock(method: string, params: unknown): boolean {
  // For eth_call / eth_getBalance / eth_getCode / eth_getStorageAt /
  // eth_getLogs, the block tag is the LAST element of `params`. If
  // it's missing, undefined, or 'latest'/'pending', treat as latest.
  if (!Array.isArray(params) || params.length === 0) return true
  const last = params[params.length - 1]
  if (last == null) return true
  if (typeof last === 'string') {
    return last === 'latest' || last === 'pending'
  }
  // eth_getLogs takes a filter object — check fromBlock/toBlock.
  if (typeof last === 'object' && method === 'eth_getLogs') {
    const f = last as any
    const tagIsLatest = (v: any) => v == null || v === 'latest' || v === 'pending'
    return tagIsLatest(f.fromBlock) || tagIsLatest(f.toBlock)
  }
  return false
}

function pickTtlMs(method: string, params: unknown): number | null {
  const latestTtl = CACHEABLE_LATEST_MS[method]
  if (latestTtl == null) return null
  return isLatestBlock(method, params) ? latestTtl : LONG_TTL_MS
}

// ─────────────────────────────────────────────────────────────────
// Upstream forwarder
// ─────────────────────────────────────────────────────────────────

function parseUpstreamUrl(raw: string): { url: string; auth: string | null } {
  if (!raw) return { url: '', auth: null }
  // raw is like https://:SECRET@base-sepolia.infura.io/v3/PROJECTID
  // Pull the secret out and use Authorization: Basic instead.
  try {
    const u = new URL(raw)
    if (u.password) {
      let secret: string
      try { secret = decodeURIComponent(u.password) }
      catch { secret = u.password }
      u.username = ''
      u.password = ''
      return {
        url: u.toString(),
        auth: 'Basic ' + Buffer.from(':' + secret).toString('base64'),
      }
    }
    return { url: raw, auth: null }
  } catch {
    return { url: raw, auth: null }
  }
}

/**
 * Primary + any operator-configured fallback URLs (L1_RPC_URL_HTTP_FALLBACK /
 * L2_RPC_URL_HTTP_FALLBACK, comma-separated — see rpcProvider.ts). Always
 * returns at least one entry when a primary is configured, possibly empty
 * when it isn't (existing "RPC upstream not configured" behaviour).
 */
function getUpstreams(chain: Chain): { url: string; auth: string | null }[] {
  const raws = chain === 'l1' ? getL1HttpRpcUrls() : getL2HttpRpcUrls()
  return raws.map(parseUpstreamUrl).filter(u => u.url)
}

/**
 * Upstream forwarder with bounded timeout + one-shot retry on transient errors.
 *
 * Returns a JSON-RPC-shaped response in ALL failure modes (timeout, network
 * error, upstream HTTP 5xx). NEVER throws. The caller (makeHandler) only
 * needs to fall back to its own catch on truly unexpected exceptions (e.g.
 * a config error from getUpstream throwing before we reach this fn).
 *
 * Why 200-with-error vs HTTP 500: viem/wagmi treats a non-2xx HTTP status
 * as a hard transport failure and refuses to surface the body to the
 * caller's `.error` handler — it just throws a CALL_EXCEPTION that
 * propagates up through every read hook on the page (cawonce sync,
 * balance reads, session-spent reads) and crashes the FE. Returning 200
 * with a properly-shaped `error: { code, message }` body lets clients
 * handle this gracefully (their `useReadContract` returns `error`, not
 * an uncaught throw) and shows users a "RPC unavailable, retrying…"
 * state instead of a blank screen.
 */
const UPSTREAM_TIMEOUT_MS = 8_000

// Note: don't annotate the return type as `Response` — that name collides
// with the Express `Response` imported at the top of this file. The native
// fetch Response is implicit via the fetch() return.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function jsonRpcError(id: any, code: number, message: string): any {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * Single-upstream forward with a one-shot retry on transient failures
 * (timeout / network error / 5xx / burst-throttle 401/429). Unchanged from
 * the original single-URL implementation — just parameterized on which
 * upstream to hit, so forwardUpstream() (below) can loop it across
 * primary + fallback.
 */
async function forwardToOneUpstream(url: string, auth: string | null, body: any): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth

  // One-shot retry: try, and if it's a transient failure (timeout / network /
  // upstream 5xx) try once more after a short delay. Most Infura blips clear
  // in <500ms; a single retry is enough to ride them out without amplifying
  // sustained outages.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, UPSTREAM_TIMEOUT_MS)
      if (res.ok) {
        return res.json()
      }
      // Non-2xx retry policy:
      //   5xx           → transient upstream fault, retry once.
      //   401 / 429     → Infura surfaces per-second compute-unit burst
      //                   throttling as 401 "project ID does not have
      //                   access to this network" (NOT a clean 429) when
      //                   many pollers share one key. These windows clear
      //                   in <500ms, so a single retry after a short delay
      //                   rides them out. A genuinely dead key returns 401
      //                   on the retry too and we surface it then — we never
      //                   loop, so a real auth failure still fails fast (one
      //                   extra 200ms, acceptable). See memory
      //                   project_infura_401_is_burst_contention.
      //   other 4xx     → permanent client error, don't retry.
      const isTransient = res.status >= 500 || res.status === 401 || res.status === 429
      if (isTransient && attempt === 0) {
        await new Promise(r => setTimeout(r, 200))
        continue
      }
      return jsonRpcError((body as any)?.id, -32603, `Upstream HTTP ${res.status}`)
    } catch (e: any) {
      const msg = e?.name === 'AbortError'
        ? `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`
        : `Upstream fetch failed: ${e?.message || 'unknown'}`
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 200))
        continue
      }
      return jsonRpcError((body as any)?.id, -32603, msg)
    }
  }
  // Unreachable, but TS wants a return.
  return jsonRpcError((body as any)?.id, -32603, 'Upstream exhausted')
}

/**
 * Forward across primary + any configured fallback upstreams
 * (L1_RPC_URL_HTTP_FALLBACK / L2_RPC_URL_HTTP_FALLBACK — see rpcProvider.ts
 * getL1HttpRpcUrls/getL2HttpRpcUrls). Tries each upstream in order (primary
 * first); each already gets its own one-shot retry via
 * forwardToOneUpstream(), so a single flaky upstream costs at most one
 * extra ~200ms round trip before we move to the next one. Only the LAST
 * upstream's error is returned if all of them fail — earlier failures are
 * logged so an operator can see which upstream is degrading.
 */
async function forwardUpstream(chain: Chain, body: any): Promise<any> {
  const upstreams = getUpstreams(chain)
  if (upstreams.length === 0) {
    return jsonRpcError((body as any)?.id, -32603, 'RPC upstream not configured')
  }

  let lastResult: any = null
  for (let i = 0; i < upstreams.length; i++) {
    const { url, auth } = upstreams[i]
    lastResult = await forwardToOneUpstream(url, auth, body)
    if (!lastResult?.error) return lastResult
    if (i < upstreams.length - 1) {
      console.warn(`[rpc-proxy] ${chain} upstream ${i + 1}/${upstreams.length} failed (${lastResult.error?.message || 'unknown'}), trying fallback`)
    }
  }
  return lastResult
}

// ─────────────────────────────────────────────────────────────────
// Per-call handling (single or batched)
// ─────────────────────────────────────────────────────────────────

async function handleOne(chain: Chain, call: any): Promise<any> {
  if (!call || typeof call !== 'object' || typeof call.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: call?.id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    }
  }
  const { method, params, id } = call

  // Allowlist gate: block methods we don't serve + (optionally) reads targeting
  // non-CAW contracts, so the proxy can't be used as a general-purpose RPC.
  const blocked = screenCall(call)
  if (blocked) return blocked

  const ttl = pickTtlMs(method, params)
  if (ttl == null) {
    // Non-cacheable: forward as-is.
    return forwardUpstream(chain, call)
  }

  const key = cacheKey(chain, method, params)
  const now = Date.now()

  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) {
    // Return the cached result with the caller's request id.
    return { ...cached.body, id }
  }

  // In-flight dedup: if another request for the same key is already
  // upstream, await it instead of firing a duplicate.
  let promise = inFlight.get(key)
  if (!promise) {
    promise = (async () => {
      try {
        const upstreamBody = await forwardUpstream(chain, call)
        if (!upstreamBody?.error) {
          cache.set(key, { expiresAt: Date.now() + ttl, body: upstreamBody })
        }
        return upstreamBody
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, promise)
  }
  const result = await promise
  return { ...result, id }
}

async function handleBody(chain: Chain, body: any): Promise<any> {
  if (Array.isArray(body)) {
    // JSON-RPC batch. Handle each call independently (so a cache hit
    // for one doesn't block the others). The upstream batch endpoint
    // would also work but we'd lose per-call caching.
    return Promise.all(body.map(c => handleOne(chain, c)))
  }
  return handleOne(chain, body)
}

// ─────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────

function makeHandler(chain: Chain) {
  return async (req: Request, res: Response) => {
    try {
      const result = await handleBody(chain, req.body)
      // Always 200, even on per-call upstream errors. forwardUpstream() shapes
      // failures into JSON-RPC error bodies; viem/wagmi surfaces those to the
      // caller's `.error` handler instead of throwing a CALL_EXCEPTION. The
      // FE then has a chance to retry or show a degraded state — without this,
      // a single Infura blip blanks every contract read on the page.
      res.json(result)
    } catch (err: any) {
      // Unexpected exception path (config errors before forwardUpstream gets
      // called, malformed body, etc). Still return 200 + JSON-RPC error body
      // so the FE handles it the same way as upstream errors.
      console.error('[rpc-proxy] Unexpected handler error:', err?.message || err)
      res.status(200).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err?.message || 'Proxy error' },
      })
    }
  }
}

router.post('/l1', gate, proxyRateLimit, makeHandler('l1'))
router.post('/l2', gate, proxyRateLimit, makeHandler('l2'))

// Light health probe — confirms the proxy is wired without exposing
// upstream URLs.
router.get('/health', (_req, res) => {
  const l1 = getUpstreams('l1').length > 0
  const l2 = getUpstreams('l2').length > 0
  res.json({ l1: l1 ? 'configured' : 'missing', l2: l2 ? 'configured' : 'missing' })
})

// Periodic GC for the in-process cache so it doesn't grow unbounded.
// Cache values are tiny but with many distinct keys (eth_getLogs over
// varying ranges, eth_call with varying args) we want to evict aged
// entries. Runs every minute, drops anything past expiry plus a small
// grace window.
setInterval(() => {
  const cutoff = Date.now()
  for (const [k, v] of cache) {
    if (v.expiresAt <= cutoff) cache.delete(k)
  }
}, 60_000).unref?.()

export default router
