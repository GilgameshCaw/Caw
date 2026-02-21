import { Router, Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

// Register XMTP identity for a user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { userId, walletAddress, installationId, identityKey } = req.body

    if (!userId || !walletAddress) {
      return res.status(400).json({ error: 'userId and walletAddress are required' })
    }

    const normalizedAddress = walletAddress.toLowerCase()

    // Check if this specific user (tokenId) already has XMTP identity
    // Multiple users from the same wallet can each have their own record
    const existing = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })

    if (existing) {
      console.log('[XMTP] UserId already registered:', userId, 'with wallet:', normalizedAddress)
      // Return the existing identity for this user
      return res.json({ success: true, existing: true, identity: existing })
    }

    // Create new XMTP identity record for this user
    // Multiple users from same wallet will have duplicate walletAddress/installationId
    const identity = await prisma.xmtpIdentity.create({
      data: {
        userId,
        walletAddress: normalizedAddress,
        installationId: installationId || `install-${Date.now()}`,
        identityKey: identityKey || '',
        preKeys: {},
        signedPreKey: {},
        registrationId: Math.floor(Math.random() * 1000000),
      }
    })

    console.log('[XMTP] Registered new identity for userId:', userId, 'wallet:', normalizedAddress)

    res.json({ success: true, identity })
  } catch (error: any) {
    console.error('[XMTP] Error registering identity:', error)
    res.status(500).json({ error: error.message })
  }
})

// Check if a user has XMTP enabled by username
router.get('/check/:username', async (req: Request, res: Response) => {
  try {
    const { username } = req.params

    // Find user by username
    const user = await prisma.user.findUnique({
      where: { username }
    })

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if this specific user (tokenId) has XMTP identity
    const xmtpIdentity = await prisma.xmtpIdentity.findUnique({
      where: { userId: user.tokenId }
    })

    res.json({
      hasXmtp: !!xmtpIdentity,
      walletAddress: user.address,
      userId: user.tokenId
    })
  } catch (error: any) {
    console.error('[XMTP] Error checking identity:', error)
    res.status(500).json({ error: error.message })
  }
})

// Check by wallet address (still used by /check/:username endpoint)
router.get('/check-address/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params

    // Find any XMTP identity with this wallet address
    const identity = await prisma.xmtpIdentity.findFirst({
      where: { walletAddress: address.toLowerCase() }
    })

    res.json({
      hasXmtp: !!identity,
      identity: identity || null
    })
  } catch (error: any) {
    console.error('[XMTP] Error checking address:', error)
    res.status(500).json({ error: error.message })
  }
})

// Check by userId (for auto-registration)
router.get('/check-user/:userId', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId)

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid userId' })
    }

    const identity = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })

    res.json({
      hasXmtp: !!identity,
      identity: identity || null
    })
  } catch (error: any) {
    console.error('[XMTP] Error checking user:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
