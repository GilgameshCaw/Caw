import { Router, Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getL1HttpRpcUrl,
  getL2HttpRpcUrl,
} from '../../utils/rpcProvider'
import { originGate } from '../middleware/originGate'

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

function getUpstream(chain: Chain): { url: string; auth: string | null } {
  const raw = chain === 'l1' ? getL1HttpRpcUrl() : getL2HttpRpcUrl()
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

async function forwardUpstream(chain: Chain, body: any): Promise<any> {
  const { url, auth } = getUpstream(chain)
  if (!url) {
    throw Object.assign(new Error('RPC upstream not configured'), { status: 503 })
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  // Pass HTTP errors back as JSON-RPC errors so the FE handles them
  // through the same code path as upstream JSON-RPC error responses.
  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: (body as any)?.id ?? null,
      error: { code: -32603, message: `Upstream HTTP ${res.status}` },
    }
  }
  return res.json()
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
      res.json(result)
    } catch (err: any) {
      const status = err?.status || 500
      res.status(status).json({
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
  const l1 = !!getL1HttpRpcUrl()
  const l2 = !!getL2HttpRpcUrl()
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
