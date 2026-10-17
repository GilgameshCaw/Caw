/**
 * /api/verify/x/signup-* — session-less X gate for the OPEN sponsored mint.
 *
 * Unlike the account-LINKING flow (verify.ts /x/start-popup + /x/callback),
 * which requires an authed CAW session and links X to an existing wallet, this
 * pair runs BEFORE any account exists. It:
 *   1. Runs the OAuth flow with NO requireAuth.
 *   2. Verifies the X account is sybil-qualified: X-VERIFIED only (paid blue check)
 *      (follower count is intentionally not a branch — purchased followers are
 *      cheap). See messages/open-sponsored-flow-design.md.
 *   3. Rejects if that xUserId is already linked to any CAW identity
 *      (WalletXLink.xUserId @unique IS the global spent-set — any existing link
 *      = the free mint is already spent, in either direction).
 *   4. On success, mints a short-lived single-use "X-qualified" token (Redis)
 *      bound to the xUserId. The FE hands that token to POST /api/sponsor/bootstrap,
 *      which consumes it as an alternative to a sponsor code, reserves the
 *      xUserId before the mint (reserveXSpend), and writes the WalletXLink
 *      after it (burning the xUserId for any future claim).
 *
 * The token is the trust handoff between this verification and the mint. It is
 * Redis-backed (matches the existing sponsor rate-limit infra) rather than a
 * signed JWT, so the mint can atomically check-and-burn it.
 */
import { Router } from 'express'
import crypto from 'crypto'
import Redis from 'ioredis'
import { prisma as _prismaDefault } from '../../prismaClient'
import {
  buildAuthUrl,
  closePagePostMessage as renderClosePage,
  envOrThrow,
  exchangeCodeForUser,
  generatePkce,
  isSponsoredQualified,
  newState,
  putState,
  redirectPageWithResult as renderRedirectPage,
  takeState,
  validateRedirectUri as coreValidateRedirectUri,
  validateReturnTo,
  xOauthConfigured,
} from './xOauthCore'

const router = Router()

const _redisDefault = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// Test seams, same shape as validateSponsorCode.ts.
let _redisOverride: Redis | null = null
export function _setRedisForTest(r: Redis | null): void {
  _redisOverride = r
}
function getRedis(): Redis {
  return _redisOverride ?? _redisDefault
}
let _prismaOverride: typeof _prismaDefault | null = null
export function _setPrismaForTest(p: typeof _prismaDefault | null): void {
  _prismaOverride = p
}
function getPrisma(): typeof _prismaDefault {
  return _prismaOverride ?? _prismaDefault
}

// Signup flow uses its OWN state prefix + close-page localStorage key so it
// never collides with the account-linking flow's signals.
const STATE_PREFIX  = 'caw:xsignup:state:'
const STORAGE_KEY   = 'caw:xsignup:result'
const CALLBACK_PATH = '/api/verify/x/signup-callback'

// X-qualified token: Redis key prefix + TTL. The token is the handoff to the
// sponsor mint. Short TTL bounds replay; single-use (consumed at mint) is the
// real guard.
const QUALIFIED_PREFIX  = 'sponsor:xqualified:'
const QUALIFIED_TTL_SEC = 15 * 60

const validateRedirectUri = (raw: unknown) => coreValidateRedirectUri(raw, CALLBACK_PATH)
const closePage = (payload: Record<string, any>) => renderClosePage(payload, STORAGE_KEY)
const redirectPage = (payload: Record<string, any>, returnTo: string) =>
  renderRedirectPage(payload, returnTo, STORAGE_KEY)

/**
 * Issue a single-use X-qualified token bound to an xUserId. Stored in Redis so
 * the sponsor mint can atomically read-and-delete it (burn on use). Returns the
 * opaque token string the FE forwards to /api/sponsor/bootstrap.
 */
export async function issueXQualifiedToken(xUserId: string, xHandle: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('base64url')
  await getRedis().setex(
    QUALIFIED_PREFIX + token,
    QUALIFIED_TTL_SEC,
    JSON.stringify({ xUserId, xHandle, at: Date.now() }),
  )
  return token
}

/**
 * Consume an X-qualified token: read-and-delete (single use). Returns the bound
 * { xUserId, xHandle } or null if missing/expired/already used. Called by the
 * sponsor mint as an alternative to the sponsor-code gate.
 */
export async function consumeXQualifiedToken(token: string): Promise<{ xUserId: string; xHandle: string } | null> {
  const key = QUALIFIED_PREFIX + token
  // GET and DEL in one MULTI, so two concurrent consumes of the same token
  // cannot both read it before either deletes it. (MULTI rather than GETDEL:
  // GETDEL needs Redis 6.2+.)
  const replies = await getRedis().multi().get(key).del(key).exec()
  const raw = replies?.[0]?.[1] as string | null | undefined
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { xUserId: string; xHandle: string }
    if (!parsed.xUserId || !parsed.xHandle) return null
    return { xUserId: parsed.xUserId, xHandle: parsed.xHandle }
  } catch {
    return null
  }
}

// Per-xUserId spend marker. Each OAuth round-trip issues a fresh token, and the
// callback's already-linked check only sees mints that have finished writing
// their WalletXLink, so a token proves "this X account qualified", not "this X
// account has not minted". The mint reserves the xUserId here before it runs.
// No TTL: the WalletXLink row is the durable record, and this marker covers the
// window before it lands and the case where that write fails after the mint.
//
// The marker fails closed: a crash between the reservation and the mint, or a
// mint whose outcome is unknown, leaves the X account blocked rather than open
// to a second mint. Its value is what an operator needs to unblock it by hand:
//   { at, username }          reserved; no mint tx known
//   { at, username, txHash }  the mint tx was sent, and its outcome is unknown
// Safe to DEL only when there is no WalletXLink for the xUserId, the mint is
// not on chain (the txHash has no receipt and the sponsor's nonce has moved
// past it; without a txHash, CawProfileMinter.idByUsername(username) is 0
// after long enough that no sent mint can still be pending).
const SPENT_PREFIX = 'sponsor:xspent:'

export interface XSpendMarker {
  at: number
  username: string
  txHash?: string
}

/**
 * Reserve an xUserId for one sponsored mint of `username`. 'taken' if it is
 * already linked in WalletXLink or another mint holds the reservation. Throws
 * on a Redis or DB error; the caller must not mint in that case.
 */
export async function reserveXSpend(xUserId: string, username: string): Promise<'ok' | 'taken'> {
  const linked = await getPrisma().walletXLink.findUnique({
    where:  { xUserId },
    select: { xUserId: true },
  })
  if (linked) return 'taken'
  const marker: XSpendMarker = { at: Date.now(), username }
  const set = await getRedis().set(SPENT_PREFIX + xUserId, JSON.stringify(marker), 'NX')
  return set ? 'ok' : 'taken'
}

/**
 * Keep the reservation of a mint whose tx was sent but whose outcome is
 * unknown, and record the tx on it. Only overwrites an existing marker.
 */
export async function keepXSpendForSentTx(xUserId: string, username: string, txHash: string): Promise<void> {
  const marker: XSpendMarker = { at: Date.now(), username, txHash }
  await getRedis().set(SPENT_PREFIX + xUserId, JSON.stringify(marker), 'XX')
}

/** Give back a reservation whose mint did not happen. */
export async function releaseXSpend(xUserId: string): Promise<void> {
  await getRedis().del(SPENT_PREFIX + xUserId)
}

/**
 * POST /api/verify/x/signup-start
 * Begins the session-less X OAuth flow for a brand-new user. No auth required —
 * the X proof IS the only thing being established here. Mirrors the link flow's
 * start-popup shape (redirectUri + optional mobile returnTo) but stores no
 * tokenId/address (there is no account yet).
 */
router.post('/x/signup-start', async (req, res) => {
  // See the note on the link flow's start-popup: unconfigured answers
  // 503 up front, the catch below stays for genuine failures.
  if (!xOauthConfigured()) {
    return res.status(503).json({ error: 'X verification is not available on this node' })
  }
  try {
    const redirectUri = validateRedirectUri(req.body?.redirectUri)

    const feOrigin = req.headers.origin
      ?? (req.headers.host ? `${req.protocol}://${req.headers.host}` : null)
    if (!feOrigin && req.body?.returnTo) {
      return res.status(400).json({ error: 'returnTo requires Origin header' })
    }
    const returnTo = validateReturnTo(req.body?.returnTo, feOrigin ?? null)

    const clientId = envOrThrow('X_OAUTH_CLIENT_ID')
    const state = newState()
    const { verifier, challenge } = generatePkce()

    await putState(STATE_PREFIX, state, { codeVerifier: verifier, redirectUri, returnTo })

    return res.json({ url: buildAuthUrl({ clientId, redirectUri, state, challenge }) })
  } catch (err: any) {
    console.error('[/api/verify/x/signup-start] error:', err?.message || err)
    return res.status(500).json({ error: 'X verification is not available on this node' })
  }
})

/**
 * GET /api/verify/x/signup-callback
 * X redirects here. Exchange code → profile, check qualification + not-already-
 * linked, issue the X-qualified token, and signal the opener with
 * { ok, qualified, token?, xHandle, reason? } via the signup localStorage key.
 *
 * Note: we do NOT write a WalletXLink here. The link is written by the sponsor
 * mint AFTER it assigns an address (WalletXLink.address is NOT NULL and there's
 * no address yet at this point). The xUserId-unclaimed check here is a fast
 * pre-flight; the unique constraint at mint time is the authoritative backstop
 * against a check→mint race.
 */
router.get('/x/signup-callback', async (req, res) => {
  const code  = req.query.code as string | undefined
  const state = req.query.state as string | undefined
  const error = req.query.error as string | undefined

  let returnTo: string | null = null
  const respond = (payload: Record<string, any>) =>
    res.send(returnTo ? redirectPage(payload, returnTo) : closePage(payload))

  if (error) return res.send(closePage({ ok: false, error: 'cancelled' }))
  if (!code || !state) return res.send(closePage({ ok: false, error: 'missing_code' }))

  try {
    const parsed = await takeState<{ codeVerifier: string; redirectUri: string; returnTo?: string | null }>(
      STATE_PREFIX, state,
    )
    if (!parsed) return res.send(closePage({ ok: false, error: 'invalid_state' }))
    returnTo = parsed.returnTo || null

    let xProfile
    try {
      xProfile = await exchangeCodeForUser(code, parsed.codeVerifier, parsed.redirectUri)
    } catch (e: any) {
      return respond({ ok: false, error: e?.message || 'x_exchange_failed' })
    }

    // Already-linked check: any existing WalletXLink for this xUserId means the
    // free sponsored mint is already spent (linked via signup OR via an existing
    // account). The mint's @unique write is the authoritative backstop.
    const existing = await getPrisma().walletXLink.findUnique({
      where:  { xUserId: xProfile.xUserId },
      select: { xUserId: true },
    })
    if (existing) {
      return respond({ ok: true, qualified: false, reason: 'x_account_already_used', xHandle: xProfile.xHandle })
    }

    // Sybil qualification: X-verified only (90-day age path was dropped).
    if (!isSponsoredQualified(xProfile, Date.now())) {
      return respond({ ok: true, qualified: false, reason: 'not_qualified', xHandle: xProfile.xHandle })
    }

    const token = await issueXQualifiedToken(xProfile.xUserId, xProfile.xHandle)
    return respond({ ok: true, qualified: true, token, xHandle: xProfile.xHandle })
  } catch (err: any) {
    console.error('[/api/verify/x/signup-callback] error:', err?.message || err)
    return respond({ ok: false, error: 'internal_error' })
  }
})

export default router
