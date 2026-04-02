import { Router } from 'express'
import { ethers } from 'ethers'
import { prisma } from '../../prismaClient'
import { createSession, getSession, addAuthorization, deleteSession } from '../sessionStore'
import { extractSession } from '../middleware/auth'
import { refreshOwnership } from '../../services/UserService'
import dmService from '../../services/DmService'

const router = Router()

const MESSAGE_PREFIX = 'Verify wallet ownership for CAW\nTimestamp: '
const DM_MESSAGE_LEGACY_PREFIX = 'CAW Protocol DM Key\nUser: '
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

    // Validate message format
    if (!message.startsWith(MESSAGE_PREFIX)) {
      res.status(400).json({ error: 'Invalid message format' })
      return
    }

    // Validate timestamp freshness
    const timestampStr = message.slice(MESSAGE_PREFIX.length)
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
    // DB may store checksummed addresses while recovery returns lowercase)
    let users = await prisma.user.findMany({
      where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
      select: { tokenId: true }
    })
    let tokenIds = users.map(u => u.tokenId)

    // If no tokens found, the NFT may have been transferred — check L2 on-chain
    if (tokenIds.length === 0) {
      console.log(`[Auth] No tokens found for ${recoveredAddress}, checking on-chain ownership...`)
      const refreshed = await refreshOwnership(recoveredAddress)
      if (refreshed.length > 0) {
        console.log(`[Auth] Found ${refreshed.length} token(s) after ownership refresh:`, refreshed)
        tokenIds = refreshed
      }
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

    // Accept the message from the client, but validate it matches an expected format
    // New format: "CAW Protocol\nEnable DMs\n@username"
    // Legacy format: "CAW Protocol DM Key\nUser: {tokenId}"
    const message = clientMessage || (DM_MESSAGE_LEGACY_PREFIX + tokenId)
    if (!message.startsWith(DM_MESSAGE_PREFIX) && !message.startsWith(DM_MESSAGE_LEGACY_PREFIX)) {
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

    // Verify the recovered address owns this tokenId
    const user = await prisma.user.findUnique({
      where: { tokenId },
      select: { address: true }
    })
    if (!user || user.address.toLowerCase() !== recoveredAddress) {
      // Check on-chain in case of transfer
      const refreshed = await refreshOwnership(recoveredAddress)
      if (!refreshed.includes(tokenId)) {
        res.status(403).json({ error: 'Signature does not match the owner of this token' })
        return
      }
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
