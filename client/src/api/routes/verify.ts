import { Router } from 'express'
import crypto from 'crypto'
import Redis from 'ioredis'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// X kept the twitter.com hosts alive for backwards compat, but the
// canonical OAuth host is now x.com — stick with it so the popup looks
// right ("authorize on X" not "authorize on Twitter") and so we don't
// rely on a redirect chain that could break later.
const X_AUTH_URL  = 'https://x.com/i/oauth2/authorize'
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
const X_ME_URL    = 'https://api.x.com/2/users/me?user.fields=public_metrics'

const STATE_TTL_SEC = 10 * 60
const STATE_PREFIX  = 'caw:xverify:state:'

// Bucket boundaries (lower bounds). xFollowerBucket is the largest bucket
// boundary <= the actual follower count. UI renders "<bucket>+ followers".
// Steps: 1k, 5k, 10k, 25k, 50k, 75k, 100k, 150k, 200k, 250k, 300k, 350k,
// then +50k forever. <1k is null (no badge enrichment shown).
const FOLLOWER_BUCKETS: number[] = [
  1_000, 5_000, 10_000, 25_000, 50_000, 75_000,
  100_000, 150_000, 200_000, 250_000, 300_000, 350_000,
]
function bucketFollowers(count: number): number | null {
  if (count < FOLLOWER_BUCKETS[0]) return null
  let last = FOLLOWER_BUCKETS[0]
  for (const b of FOLLOWER_BUCKETS) {
    if (count >= b) last = b
    else return last
  }
  // Past the last fixed bucket → step by 50k.
  let b = last
  while (count >= b + 50_000) b += 50_000
  return b
}

function envOrThrow(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} not configured`)
  return v
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Validate an FE-supplied X OAuth redirect URI. CAW is decentralized —
 * any FE host can talk to any API, so we don't gate redirects on a static
 * allowlist of CORS origins. The actual security boundary is the X dev
 * app: X rejects any redirect_uri not pre-registered on the app, so even
 * if a malicious FE tries to point us at evil.com/api/verify/x/callback,
 * X kills the flow before any harm.
 *
 * Our role here is sanity-checking that what the FE sent is a plausible
 * CAW callback URL:
 *   1. Path must end with /api/verify/x/callback (route is fixed).
 *   2. Scheme must be https, OR http on localhost / 127.0.0.1 (dev).
 * Beyond that, trust the X side.
 *
 * Returns the normalized URL (trailing-slash trimmed) on success;
 * throws on invalid input.
 */
function validateRedirectUri(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new Error('redirectUri is required')
  }
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('redirectUri is not a valid URL') }

  if (parsed.pathname.replace(/\/+$/, '') !== '/api/verify/x/callback') {
    throw new Error('redirectUri must end with /api/verify/x/callback')
  }

  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error('redirectUri must use https (or http on localhost)')
  }

  // Strip query/hash so X's exact-match check doesn't see anything we
  // didn't intend to send.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * POST /api/verify/x/start-popup
 * Begins the X OAuth 2.0 + PKCE flow. Stores {tokenId, codeVerifier,
 * redirectUri, address} in Redis keyed by an opaque state nonce, then
 * returns the X authorization URL as JSON so the FE can open it in a
 * popup.
 *
 * The FE supplies redirectUri in the body, computed from the API host
 * it's currently using to call this endpoint. This is the right shape
 * for the decentralized model: we can't assume INSTANCE_API_URL equals
 * the FE's API host because they may not be on the same instance. We
 * sanity-check the shape and let X enforce the actual identity match
 * (X rejects any redirect_uri not pre-registered on the dev app).
 *
 * The token-id is verified via requireAuth({ field: 'tokenId' }) — the
 * session must have personal_signed for that exact tokenId, not just
 * "any" token. We then snap the wallet address from the User row at
 * link-initiation time so the callback handler doesn't need to revisit
 * session state.
 */
router.post('/x/start-popup', requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }

    const redirectUri = validateRedirectUri(req.body?.redirectUri)

    // Resolve the wallet that owns this token. The X link is wallet-scoped,
    // not token-scoped — every CAW profile owned by this wallet will
    // inherit the link.
    const user = await prisma.user.findUnique({
      where:  { tokenId },
      select: { address: true },
    })
    if (!user || !user.address) {
      return res.status(400).json({ error: 'token has no owner address on record' })
    }
    const address = user.address.toLowerCase()

    const clientId = envOrThrow('X_OAUTH_CLIENT_ID')

    const state = b64url(crypto.randomBytes(24))
    const { verifier, challenge } = generatePkce()

    await redis.setex(
      STATE_PREFIX + state,
      STATE_TTL_SEC,
      JSON.stringify({ tokenId, address, codeVerifier: verifier, redirectUri })
    )

    const params = new URLSearchParams({
      response_type:         'code',
      client_id:             clientId,
      redirect_uri:          redirectUri,
      scope:                 'users.read tweet.read offline.access',
      state,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    })

    return res.json({ url: `${X_AUTH_URL}?${params.toString()}` })
  } catch (err: any) {
    console.error('[/api/verify/x/start-popup] error:', err?.message || err)
    // Surface env-config and validation errors verbatim so misconfig is
    // obvious instead of hiding behind a generic 500.
    const msg = typeof err?.message === 'string'
      && (/not configured/.test(err.message) || /redirectUri/.test(err.message))
      ? err.message
      : 'Failed to start X verification'
    return res.status(500).json({ error: msg })
  }
})

/**
 * GET /api/verify/x/callback
 * X redirects the user here with ?code & ?state. We exchange code →
 * access token → /2/users/me, persist a WalletXLink for the wallet
 * captured at /start-popup time, mark the initiating profile's badge
 * visible (and flip sibling profiles owned by the same wallet to
 * not-visible-by-default). Discard the OAuth tokens. On both success
 * and failure we render a tiny page that postMessages the opener and
 * closes the popup so it never gets stuck.
 */
router.get('/x/callback', async (req, res) => {
  // No requireAuth here — auth is via the state nonce we issued at /start.
  // The session token never enters the X-side URL.
  const code  = req.query.code as string | undefined
  const state = req.query.state as string | undefined
  const error = req.query.error as string | undefined

  if (error) {
    return res.send(closePagePostMessage({ ok: false, error: 'cancelled' }))
  }
  if (!code || !state) {
    return res.send(closePagePostMessage({ ok: false, error: 'missing_code' }))
  }

  try {
    const stored = await redis.get(STATE_PREFIX + state)
    if (!stored) {
      return res.send(closePagePostMessage({ ok: false, error: 'invalid_state' }))
    }
    await redis.del(STATE_PREFIX + state)

    const parsed = JSON.parse(stored) as {
      tokenId:      number
      address:      string
      codeVerifier: string
      redirectUri:  string
    }
    const { tokenId, address, codeVerifier, redirectUri } = parsed

    const clientId     = envOrThrow('X_OAUTH_CLIENT_ID')
    const clientSecret = envOrThrow('X_OAUTH_CLIENT_SECRET')

    // Exchange code for access token. X requires HTTP Basic auth here even
    // for confidential clients using PKCE. Use the SAME redirect_uri that
    // /start-popup sent — X verifies they match.
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
      console.error('[/api/verify/x/callback] token exchange failed:', tokenRes.status, text)
      return res.send(closePagePostMessage({ ok: false, error: 'token_exchange_failed' }))
    }
    const tokenJson = await tokenRes.json() as { access_token?: string }
    const accessToken = tokenJson.access_token
    if (!accessToken) {
      return res.send(closePagePostMessage({ ok: false, error: 'no_access_token' }))
    }

    // Fetch the linked X account + follower count.
    const meRes = await fetch(X_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!meRes.ok) {
      const text = await meRes.text().catch(() => '')
      console.error('[/api/verify/x/callback] users/me failed:', meRes.status, text)
      return res.send(closePagePostMessage({ ok: false, error: 'me_fetch_failed' }))
    }
    const meJson = await meRes.json() as {
      data?: { id?: string; username?: string; public_metrics?: { followers_count?: number } }
    }
    const xUserId   = meJson.data?.id
    const xHandle   = meJson.data?.username
    const followers = meJson.data?.public_metrics?.followers_count ?? 0
    if (!xUserId || !xHandle) {
      return res.send(closePagePostMessage({ ok: false, error: 'malformed_x_response' }))
    }

    // First-link-wins on xUserId GLOBALLY: if this X account is already
    // linked to a different wallet, reject. The @unique constraint is
    // the source of truth; this lookup just produces a friendlier error.
    const existing = await prisma.walletXLink.findUnique({
      where:  { xUserId },
      select: { address: true },
    })
    if (existing && existing.address !== address) {
      return res.send(closePagePostMessage({ ok: false, error: 'x_account_already_linked' }))
    }

    const bucket = bucketFollowers(followers)
    const now = new Date()

    // Upsert by address: re-running OAuth on the same wallet refreshes the
    // bucket. xUserId is also unique, but address is the natural key for
    // this operation (the wallet completed the proof).
    await prisma.walletXLink.upsert({
      where:  { address },
      update: {
        xUserId,
        xHandle,
        xFollowerBucket:    bucket,
        followersUpdatedAt: now,
      },
      create: {
        address,
        xUserId,
        xHandle,
        xFollowerBucket: bucket,
        linkedAt:           now,
        followersUpdatedAt: now,
      },
    })

    // Per-profile visibility: at link time we want
    //   - the initiating profile to show the badge (xBadgeVisible=true)
    //   - sibling profiles owned by the same wallet to default to OFF
    //     so the user opts each one in deliberately.
    // The User schema defaults xBadgeVisible to true, so on first link we
    // explicitly flip siblings to false. On subsequent re-links of an
    // already-linked wallet we leave existing settings alone (the user
    // may have toggled some on already).
    const isFirstLink = !existing
    if (isFirstLink) {
      await prisma.user.updateMany({
        where: { address: { equals: address, mode: 'insensitive' }, tokenId: { not: tokenId } },
        data:  { xBadgeVisible: false },
      })
    }
    // Ensure the initiating profile is visible regardless.
    await prisma.user.update({
      where: { tokenId },
      data:  { xBadgeVisible: true },
    })

    return res.send(closePagePostMessage({
      ok:       true,
      xHandle,
      bucket,
    }))
  } catch (err: any) {
    console.error('[/api/verify/x/callback] error:', err?.message || err)
    return res.send(closePagePostMessage({ ok: false, error: 'internal_error' }))
  }
})

/**
 * DELETE /api/verify/x
 * Unlinks the X account from the wallet that owns the requesting token.
 * User-initiated only. Resets every owned profile's xBadgeVisible to the
 * default (true) so a future re-link starts clean.
 *
 * Same per-token authorization story as /x/start-popup — the FE passes
 * tokenId in the body and the middleware verifies the session actually
 * authorized that exact tokenId.
 */
router.delete('/x', requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }
    const user = await prisma.user.findUnique({
      where:  { tokenId },
      select: { address: true },
    })
    if (!user || !user.address) {
      return res.status(400).json({ error: 'token has no owner address on record' })
    }
    const address = user.address.toLowerCase()

    await prisma.walletXLink.deleteMany({ where: { address } })
    await prisma.user.updateMany({
      where: { address: { equals: address, mode: 'insensitive' } },
      data:  { xBadgeVisible: true },
    })
    return res.json({ ok: true })
  } catch (err: any) {
    console.error('[/api/verify/x DELETE] error:', err?.message || err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/verify/x/wallet-status?tokenId=N
 * Returns the wallet's X link + every CAW profile owned by the same
 * wallet with its current xBadgeVisible setting. The Settings →
 * Connected Accounts panel uses this as a single source of truth so
 * the toggles stay in sync with backend state without N round-trips.
 *
 * Auth via tokenId: must have a session that personal_signed for that
 * tokenId. We resolve the wallet from User.address — same trust story
 * as the start-popup flow.
 */
router.get('/x/wallet-status', requireAuth({ lookup: async (req) => Number(req.query.tokenId) || undefined }), async (req, res) => {
  try {
    const tokenId = Number(req.query.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }
    const me = await prisma.user.findUnique({
      where:  { tokenId },
      select: { address: true },
    })
    if (!me || !me.address) {
      return res.status(400).json({ error: 'token has no owner address on record' })
    }
    const address = me.address.toLowerCase()

    const [link, siblings] = await Promise.all([
      prisma.walletXLink.findUnique({
        where:  { address },
        select: { xHandle: true, xFollowerBucket: true, linkedAt: true },
      }),
      prisma.user.findMany({
        where: { address: { equals: address, mode: 'insensitive' } },
        select: { tokenId: true, username: true, xBadgeVisible: true },
        orderBy: { tokenId: 'asc' },
      }),
    ])

    return res.json({
      link: link
        ? { xHandle: link.xHandle, xFollowerBucket: link.xFollowerBucket ?? null, linkedAt: link.linkedAt }
        : null,
      profiles: siblings,
    })
  } catch (err: any) {
    console.error('[/api/verify/x/wallet-status] error:', err?.message || err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * PUT /api/verify/x/visibility
 * Toggle the X badge on/off for a specific profile owned by the
 * requesting wallet. Doesn't touch the WalletXLink itself — only flips
 * User.xBadgeVisible. tokenId scoping uses the same per-token auth
 * pattern as the rest of this route.
 */
router.put('/x/visibility', requireAuth({ field: 'tokenId' }), async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    const visible = req.body?.visible
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ error: 'visible (boolean) is required' })
    }
    await prisma.user.update({
      where: { tokenId },
      data:  { xBadgeVisible: visible },
    })
    return res.json({ ok: true })
  } catch (err: any) {
    console.error('[/api/verify/x/visibility] error:', err?.message || err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Renders a tiny self-closing HTML page that signals the opener via
 * localStorage and then closes itself.
 *
 * Why localStorage and not postMessage(opener)? Modern browsers sever the
 * window.opener reference and lie about window.closed when the popup
 * navigates cross-origin (to x.com and back). That breaks both the
 * "postMessage to opener" channel and the "poll w.closed in opener" channel.
 *
 * The callback page is on the SAME ORIGIN as the opener (we just redirected
 * from x.com back to our own /api/verify/x/callback). So localStorage is
 * shared, and the `storage` event fires in OTHER same-origin documents
 * (i.e. the opener) when this popup writes a key. Cleanly sidesteps all
 * the opener-isolation gymnastics.
 *
 * Key shape: caw:xverify:result + a stamped nonce so a stale write from a
 * previous attempt doesn't get treated as the current one. The opener
 * filters by the nonce it stamped at start-popup time? No — simpler: we
 * write a fresh timestamp every time, and the opener uses the value's
 * presence (and freshness) to act exactly once per attempt by clearing
 * the key immediately on read.
 */
function closePagePostMessage(payload: Record<string, any>): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><title>X verification</title>
<script>
(function () {
  try {
    var envelope = { source: 'caw-xverify', payload: ${json}, at: Date.now() };
    localStorage.setItem('caw:xverify:result', JSON.stringify(envelope));
  } catch (e) {}
  window.close();
  setTimeout(function(){ document.body.textContent = 'You can close this window.'; }, 200);
})();
</script>`
}

export default router
