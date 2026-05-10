import { Router } from 'express'
import { ethers } from 'ethers'
import { prisma } from '../../prismaClient'
import { createSession, getSession, addAuthorization, deleteSession } from '../sessionStore'
import { extractSession } from '../middleware/auth'
// Tier 1 + Tier 3 of the "RPC out of API request handlers" refactor
// (PROJECT_BACKLOG.md): findOrCreateUser, verifyOwnershipOnChain, and
// syncTokensOwnedByWallet are intentionally NOT imported. API endpoints
// read only from the DB; on a miss we return 202 and let the indexer
// (NftTransferWatcher + RawEventsGatherer) populate rows asynchronously.
// The frontend retries on 202 via apiFetch + retryOnIndexing.
import dmService from '../../services/DmService'

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
const DM_MESSAGE_PREFIX = 'CAW Protocol\nEnable DMs\n@'
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000 // 5 minutes

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
    if (!expectedHost || claimedHost !== expectedHost) {
      res.status(400).json({ error: 'Message host does not match this API origin' })
      return
    }

    const claimedChainId = chainIdLine.slice('ChainId: '.length).trim()
    if (!/^\d+$/.test(claimedChainId)) {
      res.status(400).json({ error: 'Invalid chainId in message' })
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

    // Get or create session
    let sessionToken = req.headers['x-session-token'] as string | undefined
    let session = sessionToken ? await getSession(sessionToken) : null

    if (!session) {
      const created = await createSession()
      sessionToken = created.token
      session = created.session
    }

    // Add authorization
    const updated = await addAuthorization(sessionToken!, recoveredAddress, tokenIds)

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

    // Create or extend auth session
    let sessionToken = req.headers['x-session-token'] as string | undefined
    let session = sessionToken ? await getSession(sessionToken) : null

    if (!session) {
      const created = await createSession()
      sessionToken = created.token
      session = created.session
    }

    const updated = await addAuthorization(sessionToken!, recoveredAddress, tokenIds)

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

    const sessionToken = req.headers['x-session-token'] as string

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
    const token = req.headers['x-session-token'] as string | undefined
    if (token) {
      await deleteSession(token)
    }
    res.json({ success: true })
  } catch (error) {
    console.error('POST /api/auth/logout error:', error)
    res.status(500).json({ error: 'Failed to logout' })
  }
})

export default router
