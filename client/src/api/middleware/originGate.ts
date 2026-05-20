import { Request, Response } from 'express'

/**
 * Shared origin allowlist middleware for backend proxy routes (rpc-proxy,
 * ai-proxy, etc.). Without this, any script anywhere on the internet could
 * POST to a proxy endpoint — CORS only stops browsers from READING
 * cross-origin responses; it doesn't stop the server from processing the
 * request itself.
 *
 * Default behaviour: allow same-host requests — i.e. the request's Origin
 * (or Referer) host equals the Host header (the server's own public
 * hostname). This is the common case and needs ZERO config: the FE served
 * from https://test.caw.social fetching /api/rpc/l2 sends
 * Origin: https://test.caw.social and Host: test.caw.social, which match.
 *
 * Extra allowlists for cross-origin clients (peer mirrors, dev hosts,
 * or operator scripts):
 *   - ALLOWED_ORIGINS env (comma-separated). '*' opens to anyone.
 *   - PUBLIC_URL env (operator's explicit public hostname, if it
 *     differs from the Host header — e.g. behind a CDN that rewrites).
 *
 * NOTE: extracted from routes/rpc-proxy.ts so multiple proxy routers can
 * share the same gate without duplicating it. Behaviour is identical to
 * the prior inline implementation — including the startup log prefix.
 */

function parseAllowedOrigins(): { exact: Set<string>; wildcard: boolean } {
  const exact = new Set<string>()
  let wildcard = false
  for (const raw of (process.env.ALLOWED_ORIGINS || '').split(',')) {
    const o = raw.trim()
    if (!o) continue
    if (o === '*') { wildcard = true; continue }
    exact.add(o.replace(/\/$/, ''))
  }
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (publicUrl) exact.add(publicUrl)
  return { exact, wildcard }
}
const allowed = parseAllowedOrigins()
if (process.env.NODE_ENV !== 'test') {
  if (allowed.wildcard) {
    console.warn('[rpc-proxy] ALLOWED_ORIGINS includes "*" — anyone can hit /api/rpc/*. OK for dev, NOT for prod.')
  } else if (allowed.exact.size > 0) {
    console.log(`[rpc-proxy] Origin allowlist (in addition to same-host): ${Array.from(allowed.exact).join(', ')}`)
  } else {
    console.log('[rpc-proxy] Same-host requests allowed; no extra cross-origin allowlist configured.')
  }
}

// Same-host check: the Origin/Referer host matches the request's
// Host header. Express tracks the proxied Host via req.hostname when
// 'trust proxy' is set (it is — server.ts: app.set('trust proxy', 'loopback')).
// We also compare against req.headers.host raw as a fallback.
function requestSelfOrigins(req: Request): string[] {
  const hosts = new Set<string>()
  if (req.hostname) hosts.add(req.hostname)
  const rawHost = (req.headers.host || '').split(',')[0].trim()
  if (rawHost) hosts.add(rawHost.replace(/:\d+$/, '')) // strip port; Origin doesn't carry it for default ports
  // Build both http and https variants — TLS termination is at nginx,
  // so `req.protocol` may say 'http' even when the public scheme is
  // https. Accept both; the only attacker who could spoof either is
  // already on the loopback interface, which we trust.
  const origins: string[] = []
  for (const h of hosts) {
    origins.push(`https://${h}`)
    origins.push(`http://${h}`)
    if (rawHost && rawHost.includes(':')) {
      origins.push(`https://${rawHost}`)
      origins.push(`http://${rawHost}`)
    }
  }
  return origins
}

function originAllowed(req: Request): boolean {
  if (allowed.wildcard) return true
  // Prefer Origin (browser-set on fetch from a different page). Fall
  // back to Referer. One must be present AND match — no header = block.
  const origin = (req.headers.origin || '').replace(/\/$/, '')
  let candidate = origin
  if (!candidate) {
    const referer = req.headers.referer || ''
    if (referer) {
      try {
        const u = new URL(referer)
        candidate = `${u.protocol}//${u.host}`
      } catch { /* malformed referer */ }
    }
  }
  if (!candidate) return false

  // Same-host: the candidate matches one of the request's own self
  // origins. No env config needed.
  for (const self of requestSelfOrigins(req)) {
    if (candidate === self) return true
  }
  // Extra explicit allowlist for peer mirrors / dev hosts.
  if (allowed.exact.has(candidate)) return true
  return false
}

/**
 * Express middleware factory: rejects any request whose Origin (or Referer
 * fallback) doesn't match same-host or the explicit allowlist.
 *
 * The decision logic (originAllowed) is genuinely shared across proxies.
 * The 403 response body is NOT — rpc-proxy speaks JSON-RPC, ai-proxy
 * speaks a simple `{ error: { kind, message } }` shape, and a future
 * caller might want a third. Each caller passes its own builder so the
 * gate doesn't leak the contract of one consumer onto another.
 *
 * Usage:
 *   const gate = originGate(() => ({ error: { kind: 'network', message: 'origin not allowed' } }))
 *   router.post('/foo', gate, handler)
 */
export function originGate(buildBlockedBody: () => unknown) {
  return (req: Request, res: Response, next: () => void) => {
    if (originAllowed(req)) return next()
    res.status(403).json(buildBlockedBody())
  }
}
