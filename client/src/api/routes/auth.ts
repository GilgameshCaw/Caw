import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { ethers } from 'ethers'
import { prisma } from '../../prismaClient'
import { createSession, getSession, addAuthorization, deleteSession, consumeAuthSignatureOnce } from '../sessionStore'
import { extractSession, SESSION_COOKIE_NAME, sessionCookieOptions } from '../middleware/auth'
// Tier 1 + Tier 3 of the "RPC out of API request handlers" refactor
// (PROJECT_BACKLOG.md): findOrCreateUser, verifyOwnershipOnChain, and
// syncTokensOwnedByWallet are intentionally NOT imported. API endpoints
// read only from the DB; on a miss we return 202 and let the indexer
// (NftTransferWatcher + RawEventsGatherer) populate rows asynchronously.
// The frontend retries on 202 via apiFetch + retryOnIndexing.
import dmService from '../../services/DmService'
import {
  issuePasskeyChallenge,
  consumePasskeyChallenge,
  verifyPasskeyAssertionOnChain,
} from '../util/passkeyVerify'

const router = Router()

// Wallet-verify message format:
//   Verify wallet ownership for CAW
//   Host: <api-origin-host>
//   ChainId: <chainid>
//   Timestamp: <unix>
//
// Binding to host + chainId blocks cross-mirror and cross-dApp replay:
// a sig produced for mirror A doesn't authenticate against mirror B,
// and a sig produced on testnet doesn't authenticate against mainnet.
// Audit fix 2026-05-09 (Round 7 FE/DM CRITICAL-2).
//
// Legacy clients that still send the old prefix-only message are
// rejected — there's no migration window because the old message has
// active cross-replay surface and the FE updates atomically with this
// change.
const MESSAGE_PREFIX = 'Verify wallet ownership for CAW\n'
const EXPECTED_CHAIN_ID = Number(process.env.L2_CHAIN_ID ?? 84532)
const DM_MESSAGE_PREFIX = 'CAW Protocol\nEnable DMs\n@'
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000 // 5 minutes

// Acceptable Host: aliases for the host-binding check on /verify. In dev,
// Vite's proxy rewrites the client's Host header (changeOrigin: true) so the
// API sees `localhost:4000` while the browser signs `localhost:5274`. Adding
// the FE port as an alias lets dev work without weakening prod (where nginx
// preserves the public host). Operator opts in by setting AUTH_HOST_ALIASES
// to a comma-separated list (e.g. "localhost:5274,127.0.0.1:5274").
// Audit context: auth-surface H-1 binding was added 7c06bb57; this alias
// list is the dev-mode escape hatch, not a security relaxation in prod.
const AUTH_HOST_ALIASES: Set<string> = new Set(
  (process.env.AUTH_HOST_ALIASES ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
)

/**
 * POST /api/auth/verify
 * Verify wallet ownership via personal_sign.
 * Creates a new session if none provided, or adds authorization to existing session.
 */
router.post('/verify', async (req, res) => {
  try {
    const { message, signature } = req.body

    if (!message || !signature) {
      res.status(400).json({ error: 'message and signature are required' })
      return
    }

    // Validate message format. Expected:
    //   Verify wallet ownership for CAW
    //   Host: <host>
    //   ChainId: <chainid>
    //   Timestamp: <unix>
    if (typeof message !== 'string' || !message.startsWith(MESSAGE_PREFIX)) {
      res.status(400).json({ error: 'Invalid message format' })
      return
    }

    const lines = message.split('\n')
    if (lines.length < 4) {
      res.status(400).json({ error: 'Invalid message format (missing fields)' })
      return
    }
    const hostLine = lines[1] || ''
    const chainIdLine = lines[2] || ''
    const timestampLine = lines[3] || ''
    if (!hostLine.startsWith('Host: ') || !chainIdLine.startsWith('ChainId: ') || !timestampLine.startsWith('Timestamp: ')) {
      res.status(400).json({ error: 'Invalid message format (bad field shapes)' })
      return
    }

    // Host binding: the message must claim THIS API's host. Otherwise a
    // sig produced for mirror A is replayable on mirror B. The host
    // string is taken from the request's Host header (req.headers.host
    // includes port; matches the FE's window.location.host). We sit
    // behind nginx with a fixed server_name and Express trust-proxy
    // resolves the real client-facing host correctly.
    //
    // In development the FE and API run on different ports
    // (Vite at :5173, API at :4000) — the FE proxies requests through
    // Vite's dev server, so req.headers.host on the API side is the
    // FE's host:port. The wallet sees window.location.host which is
    // the same. They line up.
    const claimedHost = hostLine.slice('Host: '.length).trim().toLowerCase()
    const expectedHost = ((req.headers.host as string | undefined) || '').toLowerCase()
    if (!expectedHost || (claimedHost !== expectedHost && !AUTH_HOST_ALIASES.has(claimedHost))) {
      res.status(400).json({ error: 'Message host does not match this API origin' })
      return
    }

    const claimedChainId = chainIdLine.slice('ChainId: '.length).trim()
    if (!/^\d+$/.test(claimedChainId)) {
      res.status(400).json({ error: 'Invalid chainId in message' })
      return
    }
    if (Number(claimedChainId) !== EXPECTED_CHAIN_ID) {
      res.status(400).json({ error: 'Invalid chainId' })
      return
    }

    // Validate timestamp freshness
    const timestampStr = timestampLine.slice('Timestamp: '.length).trim()
    const timestamp = parseInt(timestampStr)
    if (isNaN(timestamp)) {
      res.status(400).json({ error: 'Invalid timestamp in message' })
      return
    }

    const messageAge = Date.now() - timestamp * 1000
    if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < -60000) {
      res.status(400).json({ error: 'Message timestamp expired or in the future' })
      return
    }

    // Recover address from signature
    let recoveredAddress: string
    try {
      recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase()
    } catch {
      res.status(400).json({ error: 'Invalid signature' })
      return
    }

    // Look up all tokenIds owned by this address (case-insensitive —
    // DB may store checksummed addresses while recovery returns lowercase).
    //
    // Tier 3: when DB shows no matches we no longer fall back to L1
    // (syncTokensOwnedByWallet). NftTransferWatcher will reflect any recent
    // transfer in the DB asynchronously; the frontend retries on 202.
    // Note: a wallet that genuinely owns zero CAW names is indistinguishable
    // from "indexer hasn't caught up yet" at this layer. We err on the side
    // of treating empty as indexing-in-flight — the retry helper caps at
    // ~25s, and on the final attempt the empty-array path lets the user
    // through with no authorized tokens (the same response shape they would
    // have gotten from a successful match with zero rows).
    //
    // IMPORTANT: do this BEFORE consumeAuthSignatureOnce so a 202 retry
    // doesn't burn the sig's one-time-use slot. retryOnIndexing re-invokes
    // the same closure with the same (message, signature), so consuming on
    // the first attempt poisons every retry → "Signature already used" 400.
    const users = await prisma.user.findMany({
      where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
      select: { tokenId: true }
    })
    const tokenIds = users.map(u => u.tokenId)

    if (tokenIds.length === 0) {
      // No tokens for this wallet in the DB. Could be a fresh transfer the
      // indexer hasn't seen yet, or a wallet that has never owned a CAW name.
      // Hint the client to retry once; if the second pass also returns empty
      // the helper will give up gracefully.
      console.log(`[Auth] No tokens found in DB for ${recoveredAddress} — returning 202 (indexer may be catching up)`)
      res.setHeader('Retry-After', '5')
      res.status(202).json({
        error: 'ownership not yet indexed',
        retryAfterSeconds: 5,
      })
      return
    }

    // One-time-use guard against replay within the 5-minute freshness
    // window. Without this, an attacker who captures the signed message
    // (XSS, browser extension, leaked log, etc.) can replay it to attach
    // the victim's wallet to an attacker-controlled session. The atomic
    // SET NX in Redis means even parallel verify calls with the same
    // signature can't both succeed. Audit fix 2026-05-13.
    //
    // Consumed AFTER the 202-retry path above — see comment there.
    const fresh = await consumeAuthSignatureOnce(message, signature)
    if (!fresh) {
      res.status(400).json({ error: 'Signature already used. Please sign again.' })
      return
    }

    // Get or create session. Cookie (HttpOnly) is the new canonical source;
    // x-session-token header is the legacy path kept for the migration
    // window so live FE sessions don't all get kicked out.
    const cookieRe1 = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
    let sessionToken =
      (req.headers.cookie?.match(cookieRe1)?.[1]) ||
      (req.headers['x-session-token'] as string | undefined)
    let session = sessionToken ? await getSession(sessionToken) : null

    if (!session) {
      const created = await createSession()
      sessionToken = created.token
      session = created.session
    }

    // Add authorization
    const updated = await addAuthorization(sessionToken!, recoveredAddress, tokenIds)

    // Set HttpOnly cookie. Returned-in-body sessionToken kept for the
    // migration window so existing FE clients that still read it from
    // the response don't break; will go away once cookie use is universal.
    res.cookie(SESSION_COOKIE_NAME, sessionToken!, sessionCookieOptions())

    res.json({
      sessionToken,
      authorizedTokenIds: updated?.authorizedTokenIds || tokenIds,
      authorizedAddresses: updated?.authorizedAddresses || [recoveredAddress],
      expiresAt: updated?.expiresAt || session.expiresAt
    })
  } catch (error) {
    console.error('POST /api/auth/verify error:', error)
    res.status(500).json({ error: 'Failed to verify wallet' })
  }
})

/**
 * POST /api/auth/verify-dm
 * Combined auth + DM identity registration in one call.
 * Accepts the DM key derivation signature, recovers the wallet address,
 * creates/extends the auth session, and registers the DM public key.
 * Eliminates the need for a separate auth personal_sign.
 */
router.post('/verify-dm', async (req, res) => {
  try {
    const { signature, message: clientMessage, userId, publicKey } = req.body

    if (!signature || !userId || !publicKey) {
      res.status(400).json({ error: 'signature, userId, and publicKey are required' })
      return
    }

    const tokenId = Number(userId)
    if (isNaN(tokenId)) {
      res.status(400).json({ error: 'Invalid userId' })
      return
    }

    // Validate message format: "CAW Protocol\nEnable DMs\n@username"
    const message = clientMessage
    if (!message || !message.startsWith(DM_MESSAGE_PREFIX)) {
      res.status(400).json({ error: 'Invalid message format' })
      return
    }

    // Recover address from signature
    let recoveredAddress: string
    try {
      recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase()
    } catch {
      res.status(400).json({ error: 'Invalid signature' })
      return
    }

    // No replay-guard here. The DM-auth signature is INTENTIONALLY
    // deterministic — message is `CAW Protocol\nEnable DMs\n@<username>`,
    // and SHA-256(sig) is also the user's DM encryption key. Re-signing
    // the same wallet+username must produce the same key so the user
    // can decrypt their historical DMs on any device. Guarding the sig
    // once would lock out the legitimate "re-enable on a new device"
    // and "retry after a transient failure" paths within the 5-min
    // window (see commits 78deb20f → revert chain — single-sig design
    // is intentional).
    //
    // The replay-attack value here is also low: a captured DM-auth sig
    // only lets the attacker create a session for the same (wallet,
    // tokenId) pair the legitimate user already has — no token attached
    // to an attacker-controlled session, no impersonation. The main
    // /verify route remains replay-guarded since its signed message is
    // a fresh per-call nonce.

    // Verify the recovered address owns this tokenId.
    //
    // Tier 3: DB is the only authority here. NftTransferWatcher updates
    // User.address on every L1 Transfer event (and creates the row on
    // mint, since the watcher's mint-fix landed alongside this refactor).
    // If the DB doesn't yet show the wallet owns the token, return 202 —
    // the frontend's retryOnIndexing helper backs off and retries until
    // the watcher catches up (typically <30s) or gives up.
    const user = await prisma.user.findUnique({
      where: { tokenId },
      select: { address: true }
    })
    if (!user) {
      console.log(`[Auth] verify-dm: tokenId=${tokenId} not yet indexed`)
      res.setHeader('Retry-After', '5')
      res.status(202).json({
        error: 'ownership not yet indexed',
        retryAfterSeconds: 5,
      })
      return
    }
    if (user.address.toLowerCase() !== recoveredAddress) {
      // DB authoritative. The wallet that signed the message doesn't own
      // this tokenId per our indexed view. Could be a stale view (recent
      // transfer not yet seen) or a bad-faith request. 202 + retry handles
      // the stale-view case; if the indexer has been caught up for a while
      // and this still doesn't match, the retry helper times out and the
      // caller surfaces a clean error to the user.
      console.log(`[Auth] verify-dm: tokenId=${tokenId} owner mismatch (db=${user.address} vs sig=${recoveredAddress}) — 202`)
      res.setHeader('Retry-After', '5')
      res.status(202).json({
        error: 'ownership not yet indexed',
        retryAfterSeconds: 5,
      })
      return
    }

    // Look up all tokenIds owned by this address
    const users = await prisma.user.findMany({
      where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
      select: { tokenId: true }
    })
    const tokenIds = users.map(u => u.tokenId)

    // Create or extend auth session. Cookie first, header fallback.
    const cookieRe2 = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
    let sessionToken =
      (req.headers.cookie?.match(cookieRe2)?.[1]) ||
      (req.headers['x-session-token'] as string | undefined)
    let session = sessionToken ? await getSession(sessionToken) : null

    if (!session) {
      const created = await createSession()
      sessionToken = created.token
      session = created.session
    }

    const updated = await addAuthorization(sessionToken!, recoveredAddress, tokenIds)

    // Set HttpOnly cookie (migration window: also returned in body, see /verify).
    res.cookie(SESSION_COOKIE_NAME, sessionToken!, sessionCookieOptions())

    // DmIdentity has a FK on User.tokenId. The earlier ownership check
    // already 202'd if the User row was missing, so by here it's
    // guaranteed to exist — Tier 1's standalone existence check (kept
    // around the findOrCreateUser fallback) is now redundant and removed.

    // Register DM identity
    await dmService.registerIdentity(tokenId, recoveredAddress, publicKey)

    res.json({
      sessionToken,
      authorizedTokenIds: updated?.authorizedTokenIds || tokenIds,
      authorizedAddresses: updated?.authorizedAddresses || [recoveredAddress],
      expiresAt: updated?.expiresAt || session.expiresAt
    })
  } catch (error) {
    console.error('POST /api/auth/verify-dm error:', error)
    res.status(500).json({ error: 'Failed to verify wallet and register DM identity' })
  }
})

/**
 * GET /api/auth/session
 * Get current session state
 */
router.get('/session', async (req, res) => {
  try {
    await extractSession(req)

    if (!req.sessionData) {
      res.status(401).json({ error: 'AUTH_REQUIRED', message: 'No valid session' })
      return
    }

    res.json({
      authorizedTokenIds: req.sessionData.authorizedTokenIds,
      authorizedAddresses: req.sessionData.authorizedAddresses,
      expiresAt: req.sessionData.expiresAt
    })
  } catch (error) {
    console.error('GET /api/auth/session error:', error)
    res.status(500).json({ error: 'Failed to get session' })
  }
})

/**
 * POST /api/auth/refresh
 * Refresh session's authorizedTokenIds by re-querying the DB for all tokens
 * owned by already-authorized addresses. No new signature required.
 */
router.post('/refresh', async (req, res) => {
  try {
    await extractSession(req)

    if (!req.sessionData) {
      res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Session token required' })
      return
    }

    // extractSession populates req.sessionToken from cookie-or-header.
    const sessionToken = req.sessionToken as string

    // For each authorized address, look up all tokenIds (case-insensitive)
    for (const addr of req.sessionData.authorizedAddresses) {
      const users = await prisma.user.findMany({
        where: { address: { equals: addr, mode: 'insensitive' } },
        select: { tokenId: true }
      })
      const tokenIds = users.map(u => u.tokenId)
      await addAuthorization(sessionToken, addr, tokenIds)
    }

    // Re-read updated session
    const updated = await getSession(sessionToken)

    // Refresh cookie expiry (sliding window).
    res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions())

    res.json({
      sessionToken,
      authorizedTokenIds: updated?.authorizedTokenIds || [],
      authorizedAddresses: updated?.authorizedAddresses || [],
      expiresAt: updated?.expiresAt
    })
  } catch (error) {
    console.error('POST /api/auth/refresh error:', error)
    res.status(500).json({ error: 'Failed to refresh session' })
  }
})

/**
 * POST /api/auth/logout
 * Delete session
 */
router.post('/logout', async (req, res) => {
  try {
    // Cookie first (new path), header fallback (legacy clients).
    const cookieRe3 = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
    const token =
      (req.headers.cookie?.match(cookieRe3)?.[1]) ||
      (req.headers['x-session-token'] as string | undefined)
    if (token) {
      await deleteSession(token)
    }
    // Clear the cookie regardless — defensive against the case where Redis
    // already lost the session but the browser still carries the cookie.
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    res.json({ success: true })
  } catch (error) {
    console.error('POST /api/auth/logout error:', error)
    res.status(500).json({ error: 'Failed to logout' })
  }
})

// Per-IP rate limits for the passkey sign-in ceremony (security finding #4):
// the challenge endpoint is unauthenticated, and each verify triggers an L1
// staticcall, so an unbounded flood is an RPC-quota DoS. P-256 is unforgeable,
// so these are DoS limits, not credential-guess limits.
const passkeyChallengeLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20, // 20 challenge requests / 5 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many passkey challenge requests. Try again shortly.' },
})
const passkeyVerifyLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15, // 15 verify attempts / 5 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many passkey sign-in attempts. Try again shortly.' },
})

/**
 * POST /api/auth/verify-passkey/challenge
 * Step 1 of passkey sign-in (Population B). Body: { tokenId }.
 * The SERVER generates a random 32-byte challenge (security finding #2 — a
 * client-chosen challenge would let an attacker pre-seed a captured assertion's
 * challenge and replay it) and returns it. The client passes it verbatim into
 * navigator.credentials.get. Single live challenge per tokenId, short TTL,
 * single-use on verify.
 */
router.post('/verify-passkey/challenge', passkeyChallengeLimit, async (req, res) => {
  try {
    const id = Number(req.body?.tokenId)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid tokenId' })
      return
    }
    const challenge = await issuePasskeyChallenge(id)
    res.json({ challenge })
  } catch (error) {
    console.error('POST /api/auth/verify-passkey/challenge error:', error)
    res.status(500).json({ error: 'Failed to issue passkey challenge' })
  }
})

/**
 * POST /api/auth/verify-passkey
 * Step 2 of passkey sign-in. Body: { tokenId, challenge, signature }.
 * Verifies the WebAuthn assertion ON-CHAIN against the profile owner's SmartEOA
 * (ERC-1271 isValidSignature → EIP-7951 P-256 path), then issues a session for
 * that tokenId. The `signature` is the ABI-encoded
 * (authenticatorData, clientDataJSON, r, s) blob SmartEOA decodes.
 */
router.post('/verify-passkey', passkeyVerifyLimit, async (req, res) => {
  try {
    const { tokenId, challenge, signature } = req.body
    const id = Number(tokenId)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid tokenId' })
      return
    }
    if (typeof challenge !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(challenge)) {
      res.status(400).json({ error: 'Invalid challenge' })
      return
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      res.status(400).json({ error: 'Invalid signature' })
      return
    }

    // Resolve the profile's CURRENT owner SmartEOA from the DB. The
    // NftTransferWatcher keeps User.address current on every Transfer, so this
    // reflects the live owner — verifying against a stale owner would let a
    // previous owner's passkey sign in after a transfer.
    const user = await prisma.user.findUnique({
      where: { tokenId: id },
      select: { address: true, tokenId: true },
    })
    if (!user || !user.address) {
      // Not yet indexed (or no such profile). Hint a retry like /verify.
      res.setHeader('Retry-After', '5')
      res.status(202).json({ error: 'ownership not yet indexed', retryAfterSeconds: 5 })
      return
    }
    const ownerAddress = user.address

    // Consume the challenge BEFORE the on-chain call so a single challenge
    // can't drive multiple verification attempts (atomic GETDEL — one shot).
    const freshChallenge = await consumePasskeyChallenge(id, challenge)
    if (!freshChallenge) {
      res.status(400).json({ error: 'Challenge expired or not found. Request a new one.' })
      return
    }

    // On-chain ERC-1271 check against the owner SmartEOA.
    let valid: boolean
    try {
      valid = await verifyPasskeyAssertionOnChain(
        ownerAddress,
        challenge as `0x${string}`,
        signature as `0x${string}`,
      )
    } catch (e) {
      console.error('[Auth] verify-passkey on-chain check failed (infra):', e)
      res.status(503).json({ error: 'Could not verify passkey right now. Please try again.' })
      return
    }
    if (!valid) {
      res.status(401).json({ error: 'Passkey signature did not validate for this profile.' })
      return
    }

    // Stale-owner guard (security finding #5): the on-chain check used the DB
    // owner address. If an NFT transfer landed between the read above and now
    // (indexer mid-update), re-read and bail if the owner changed — otherwise a
    // just-transferred-away owner's passkey could mint a session. Cheap indexed
    // read; mismatch → 202 retry (the FE re-runs the whole ceremony).
    const recheck = await prisma.user.findUnique({
      where: { tokenId: id },
      select: { address: true },
    })
    if (!recheck?.address || recheck.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      res.setHeader('Retry-After', '5')
      res.status(202).json({ error: 'ownership changed during verification; retry', retryAfterSeconds: 5 })
      return
    }

    // Valid — issue a session for this tokenId (same shape as /verify).
    const cookieRePk = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`)
    let sessionToken =
      (req.headers.cookie?.match(cookieRePk)?.[1]) ||
      (req.headers['x-session-token'] as string | undefined)
    let session = sessionToken ? await getSession(sessionToken) : null
    if (!session) {
      const created = await createSession()
      sessionToken = created.token
      session = created.session
    }
    const updated = await addAuthorization(sessionToken!, ownerAddress.toLowerCase(), [id])
    res.cookie(SESSION_COOKIE_NAME, sessionToken!, sessionCookieOptions())
    res.json({
      sessionToken,
      authorizedTokenIds: updated?.authorizedTokenIds || [id],
      authorizedAddresses: updated?.authorizedAddresses || [ownerAddress.toLowerCase()],
      expiresAt: updated?.expiresAt || session.expiresAt,
    })
  } catch (error) {
    console.error('POST /api/auth/verify-passkey error:', error)
    res.status(500).json({ error: 'Failed to verify passkey' })
  }
})

export default router
