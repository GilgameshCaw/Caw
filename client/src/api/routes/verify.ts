import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'
import {
  bucketFollowers,
  buildAuthUrl,
  closePagePostMessage as renderClosePage,
  envOrThrow,
  exchangeCodeForUser,
  generatePkce,
  newState,
  putState,
  redirectPageWithResult as renderRedirectPage,
  takeState,
  validateRedirectUri as coreValidateRedirectUri,
  validateReturnTo,
} from './xOauthCore'

const router = Router()

// Account-LINKING flow state + close-page localStorage key. The signup flow
// (xSignup.ts) uses its own prefix/key so the two never collide.
const STATE_PREFIX  = 'caw:xverify:state:'
const STORAGE_KEY   = 'caw:xverify:result'
const CALLBACK_PATH = '/api/verify/x/callback'

// Thin wrappers so existing callsites stay terse and the close-pages bind the
// link-flow storage key.
const validateRedirectUri = (raw: unknown) => coreValidateRedirectUri(raw, CALLBACK_PATH)
const closePagePostMessage = (payload: Record<string, any>) => renderClosePage(payload, STORAGE_KEY)
const redirectPageWithResult = (payload: Record<string, any>, returnTo: string) =>
  renderRedirectPage(payload, returnTo, STORAGE_KEY)

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
router.post('/x/start-popup', requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }

    const redirectUri = validateRedirectUri(req.body?.redirectUri)
    // Optional. Present on mobile flows that swap the popup for a
    // top-level redirect; the callback page navigates the user back
    // here when finished. Falsy → desktop popup flow → callback page
    // self-closes instead.
    //
    // Same-origin enforcement: derive the allowed FE origin from the
    // request's Origin header (present on cross-origin fetch) or fall
    // back to reconstructing it from Host + protocol. This prevents an
    // adversarial operator node from injecting a foreign returnTo and
    // redirecting users to a phishing page. Fix: audit H-3.
    const feOrigin = req.headers.origin
      ?? (req.headers.host ? `${req.protocol}://${req.headers.host}` : null)
    if (!feOrigin && req.body?.returnTo) {
      return res.status(400).json({ error: 'returnTo requires Origin header' })
    }
    const returnTo = validateReturnTo(req.body?.returnTo, feOrigin ?? null)

    // verifyOwnership made requireAuth check that the session is still
    // authorized for this token's CURRENT owner. The middleware also
    // stashes the lowercased owner address on req — every CAW profile
    // owned by this wallet will inherit the X link.
    const address = req.tokenOwnerAddress!

    const clientId = envOrThrow('X_OAUTH_CLIENT_ID')

    const state = newState()
    const { verifier, challenge } = generatePkce()

    await putState(STATE_PREFIX, state, { tokenId, address, codeVerifier: verifier, redirectUri, returnTo })

    return res.json({ url: buildAuthUrl({ clientId, redirectUri, state, challenge }) })
  } catch (err: any) {
    console.error('[/api/verify/x/start-popup] error:', err?.message || err)
    return res.status(500).json({ error: 'X verification is not available on this node' })
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

  // For pre-state-lookup error paths we don't yet know if the flow was
  // mobile (returnTo) or desktop (popup). Default to popup; on mobile the
  // user lands on a page that says "you can close this window" which is
  // wrong but recoverable — they can hit back to get to the app. The
  // happy path always knows the returnTo, so this only matters for
  // adversarial inputs.
  if (error) {
    return res.send(closePagePostMessage({ ok: false, error: 'cancelled' }))
  }
  if (!code || !state) {
    return res.send(closePagePostMessage({ ok: false, error: 'missing_code' }))
  }

  // Resolve returnTo BEFORE the try-block so we can use it in catches and
  // post-state-lookup errors. Only set after the state is read.
  let returnTo: string | null = null
  const respond = (payload: Record<string, any>) => {
    return res.send(returnTo
      ? redirectPageWithResult(payload, returnTo)
      : closePagePostMessage(payload))
  }

  try {
    const parsed = await takeState<{
      tokenId:      number
      address:      string
      codeVerifier: string
      redirectUri:  string
      returnTo?:    string | null
    }>(STATE_PREFIX, state)
    if (!parsed) {
      return res.send(closePagePostMessage({ ok: false, error: 'invalid_state' }))
    }
    const { tokenId, address, codeVerifier, redirectUri } = parsed
    returnTo = parsed.returnTo || null

    // Re-verify ownership at callback time. The OAuth round-trip lasts
    // up to 10 min (state TTL); during that window the user can transfer
    // the NFT to a buyer. Without this check, the seller's X verification
    // would land on the BUYER's profile (xBadgeVisible=true is force-set
    // on the captured tokenId regardless of who owns it now). Audit fix
    // 2026-05-09 (Round 6 cross-layer agent CL-3).
    const currentOwner = await prisma.user.findUnique({
      where: { tokenId },
      select: { address: true },
    })
    if (!currentOwner?.address || currentOwner.address.toLowerCase() !== address.toLowerCase()) {
      return respond({ ok: false, error: 'token_owner_changed_during_oauth' })
    }

    // Exchange code → access token → /2/users/me (shared core). The core
    // throws a stable error code (token_exchange_failed / no_access_token /
    // me_fetch_failed / malformed_x_response) which we surface verbatim.
    let xProfile
    try {
      xProfile = await exchangeCodeForUser(code, codeVerifier, redirectUri)
    } catch (e: any) {
      return respond({ ok: false, error: e?.message || 'x_exchange_failed' })
    }
    const { xUserId, xHandle, followers } = xProfile

    // First-link-wins on xUserId GLOBALLY: if this X account is already
    // linked to a different wallet, reject. The @unique constraint is
    // the source of truth; this lookup just produces a friendlier error.
    const existing = await prisma.walletXLink.findUnique({
      where:  { xUserId },
      select: { address: true },
    })
    if (existing && existing.address !== address) {
      return respond({ ok: false, error: 'x_account_already_linked' })
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

    return respond({ ok: true, xHandle, bucket })
  } catch (err: any) {
    console.error('[/api/verify/x/callback] error:', err?.message || err)
    return respond({ ok: false, error: 'internal_error' })
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
router.delete('/x', requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req, res) => {
  try {
    const tokenId = Number(req.body?.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }
    const address = req.tokenOwnerAddress!

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
router.get('/x/wallet-status', requireAuth({ lookup: async (req) => Number(req.query.tokenId) || undefined, verifyOwnership: true }), async (req, res) => {
  try {
    const tokenId = Number(req.query.tokenId)
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: 'tokenId is required' })
    }
    const address = req.tokenOwnerAddress!

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
router.put('/x/visibility', requireAuth({ field: 'tokenId', verifyOwnership: true }), async (req, res) => {
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

export default router
