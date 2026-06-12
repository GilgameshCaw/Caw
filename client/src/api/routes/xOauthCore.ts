/**
 * xOauthCore — shared X (Twitter) OAuth 2.0 + PKCE machinery.
 *
 * Extracted from verify.ts so two consumers can share it:
 *   1. The account-LINKING flow (/api/verify/x/*) — requires an authed CAW
 *      session, persists a wallet-scoped WalletXLink.
 *   2. The session-less SIGNUP gate (/api/verify/x/signup-*) — no session;
 *      verifies an X account is sybil-qualified (age>90d OR verified) and that
 *      its xUserId hasn't already been linked, then lets the sponsor mint
 *      proceed and burn the id.
 *
 * Everything here is pure OAuth/transport plumbing + the X profile fetch.
 * Neither auth gating nor DB persistence lives here — that's the consumers'
 * job, because the two flows differ on exactly those axes.
 */
import crypto from 'crypto'
import Redis from 'ioredis'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// X kept twitter.com alive for back-compat, but x.com is canonical so the
// popup reads "authorize on X" and we don't depend on a redirect chain.
export const X_AUTH_URL  = 'https://x.com/i/oauth2/authorize'
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
// created_at + verified are needed by the signup sybil gate (age>90d OR
// verified); public_metrics drives the follower badge bucket on the link flow.
// Both consumers read from this one call — no extra paid endpoint.
export const X_ME_URL =
  'https://api.x.com/2/users/me?user.fields=public_metrics,created_at,verified,verified_type'

export const STATE_TTL_SEC = 10 * 60

export function envOrThrow(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} not configured`)
  return v
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function newState(): string {
  return b64url(crypto.randomBytes(24))
}

/** Persist arbitrary OAuth state under an opaque nonce. Each flow uses its own
 *  key prefix so signup and link states never collide. */
export async function putState(prefix: string, state: string, data: unknown): Promise<void> {
  await redis.setex(prefix + state, STATE_TTL_SEC, JSON.stringify(data))
}

/** Read-and-delete OAuth state (single-use). Returns null if missing/expired. */
export async function takeState<T = any>(prefix: string, state: string): Promise<T | null> {
  const raw = await redis.get(prefix + state)
  if (!raw) return null
  await redis.del(prefix + state)
  try { return JSON.parse(raw) as T } catch { return null }
}

/**
 * Build the X authorization URL. scope is shared across both flows.
 */
export function buildAuthUrl(opts: {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
}): string {
  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             opts.clientId,
    redirect_uri:          opts.redirectUri,
    scope:                 'users.read tweet.read offline.access',
    state:                 opts.state,
    code_challenge:        opts.challenge,
    code_challenge_method: 'S256',
  })
  return `${X_AUTH_URL}?${params.toString()}`
}

export interface XProfile {
  xUserId:   string
  xHandle:   string
  followers: number
  /** ISO 8601 account creation timestamp from X, or null if absent. */
  createdAt: string | null
  /** X Premium / blue verified. */
  verified:  boolean
}

/**
 * Exchange an OAuth code for the X profile. Does the token exchange (HTTP Basic
 * + PKCE verifier) then GET /2/users/me with the extended field set. Returns
 * the parsed profile, or throws an Error whose message is a stable code the
 * caller can surface to the close-page (token_exchange_failed, no_access_token,
 * me_fetch_failed, malformed_x_response).
 */
export async function exchangeCodeForUser(code: string, codeVerifier: string, redirectUri: string): Promise<XProfile> {
  const clientId     = envOrThrow('X_OAUTH_CLIENT_ID')
  const clientSecret = envOrThrow('X_OAUTH_CLIENT_SECRET')

  const tokenBody = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
    client_id:     clientId,
  })
  const tokenRes = await fetch(X_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: tokenBody.toString(),
  })
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '')
    console.error('[xOauthCore] token exchange failed:', tokenRes.status, text)
    throw new Error('token_exchange_failed')
  }
  const tokenJson = await tokenRes.json() as { access_token?: string }
  const accessToken = tokenJson.access_token
  if (!accessToken) throw new Error('no_access_token')

  const meRes = await fetch(X_ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!meRes.ok) {
    const text = await meRes.text().catch(() => '')
    console.error('[xOauthCore] users/me failed:', meRes.status, text)
    throw new Error('me_fetch_failed')
  }
  const meJson = await meRes.json() as {
    data?: {
      id?: string
      username?: string
      created_at?: string
      verified?: boolean
      public_metrics?: { followers_count?: number }
    }
  }
  const xUserId   = meJson.data?.id
  const xHandle   = meJson.data?.username
  if (!xUserId || !xHandle) throw new Error('malformed_x_response')

  return {
    xUserId,
    xHandle,
    followers: meJson.data?.public_metrics?.followers_count ?? 0,
    createdAt: meJson.data?.created_at ?? null,
    verified:  meJson.data?.verified ?? false,
  }
}

// Bucket boundaries (lower bounds). Largest boundary <= actual follower count.
const FOLLOWER_BUCKETS: number[] = [
  1_000, 5_000, 10_000, 25_000, 50_000, 75_000,
  100_000, 150_000, 200_000, 250_000, 300_000, 350_000,
]
export function bucketFollowers(count: number): number | null {
  if (count < FOLLOWER_BUCKETS[0]) return null
  let last = FOLLOWER_BUCKETS[0]
  for (const b of FOLLOWER_BUCKETS) {
    if (count >= b) last = b
    else return last
  }
  let b = last
  while (count >= b + 50_000) b += 50_000
  return b
}

/**
 * Sponsored-mint sybil qualification: account age > 90 days OR X-verified.
 * Follower count is intentionally NOT a branch — purchased followers are
 * cheap, so a follower bar adds no real sybil resistance. See
 * messages/open-sponsored-flow-design.md.
 */
export const SPONSORED_MIN_ACCOUNT_AGE_MS = 90 * 24 * 60 * 60 * 1000
export function isSponsoredQualified(p: Pick<XProfile, 'createdAt' | 'verified'>, nowMs: number): boolean {
  if (p.verified) return true
  if (!p.createdAt) return false
  const created = Date.parse(p.createdAt)
  if (Number.isNaN(created)) return false
  return nowMs - created > SPONSORED_MIN_ACCOUNT_AGE_MS
}

/**
 * Validate an FE-supplied X OAuth redirect URI. We don't gate on a static
 * allowlist (CAW is decentralized — any FE host can talk to any API); the real
 * boundary is X rejecting any redirect_uri not pre-registered on the dev app.
 * We just sanity-check the shape: path must end with the given fixed callback
 * path, scheme https (or http on localhost). Returns normalized URL or throws.
 */
export function validateRedirectUri(raw: unknown, callbackPath: string): string {
  if (typeof raw !== 'string' || !raw) throw new Error('redirectUri is required')
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('redirectUri is not a valid URL') }
  if (parsed.pathname.replace(/\/+$/, '') !== callbackPath) {
    throw new Error(`redirectUri must end with ${callbackPath}`)
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error('redirectUri must use https (or http on localhost)')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * Validate a returnTo URL for the mobile top-level-redirect path. https (or
 * localhost), and same-origin as the initiating FE (anti-phishing, audit H-3).
 * Returns the URL string or null (caller falls back to the popup close-page).
 */
export function validateReturnTo(raw: unknown, allowedOrigin: string | null): string | null {
  if (typeof raw !== 'string' || !raw) return null
  let parsed: URL
  try { parsed = new URL(raw) } catch { return null }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) return null
  if (allowedOrigin && parsed.origin !== allowedOrigin) return null
  return parsed.toString()
}

/**
 * Popup close-page: writes the result envelope to localStorage under
 * `storageKey` (the FE listens for a storage event on that key), then closes
 * the window. Each flow passes its own key so signup + link signals don't
 * collide.
 */
export function closePagePostMessage(payload: Record<string, any>, storageKey: string): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  const keyJs = JSON.stringify(storageKey).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><title>X verification</title>
<script>
(function () {
  try {
    var envelope = { source: 'caw-xverify', payload: ${json}, at: Date.now() };
    localStorage.setItem(${keyJs}, JSON.stringify(envelope));
  } catch (e) {}
  window.close();
  setTimeout(function(){ document.body.textContent = 'You can close this window.'; }, 200);
})();
</script>`
}

/**
 * Mobile redirect variant: writes the result to localStorage (same key the
 * popup flow uses), then top-level navigates back to returnTo.
 */
export function redirectPageWithResult(payload: Record<string, any>, returnTo: string, storageKey: string): string {
  const json     = JSON.stringify(payload).replace(/</g, '\\u003c')
  const returnJs = JSON.stringify(returnTo).replace(/</g, '\\u003c')
  const keyJs    = JSON.stringify(storageKey).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><title>Returning to CAW…</title>
<style>body{font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#000;color:#fff}</style>
<div>Returning to CAW…</div>
<script>
(function () {
  try {
    var envelope = { source: 'caw-xverify', payload: ${json}, at: Date.now() };
    localStorage.setItem(${keyJs}, JSON.stringify(envelope));
  } catch (e) {}
  try {
    window.location.replace(${returnJs});
  } catch (e) {
    document.body.textContent = 'Done. You can return to the app.';
  }
})();
</script>`
}
