import { Router } from 'express'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'

const router = Router()

/**
 * GET /api/marketplace/listings
 * Filtered, sorted, paginated active listings.
 * Query params: type, minLength, maxLength, paymentToken, sort, limit, offset, status
 */
router.get('/listings', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 24, 100)
    const offset = parseInt(req.query.offset as string) || 0
    const status = (req.query.status as string) || 'ACTIVE'
    const listingType = req.query.type as string | undefined
    const minLength = parseInt(req.query.minLength as string) || 0
    const maxLength = parseInt(req.query.maxLength as string) || 999
    const paymentToken = req.query.paymentToken as string | undefined
    const sort = (req.query.sort as string) || 'newest'

    const where: any = {
      status,
      usernameLength: { gte: minLength, lte: maxLength },
    }

    if (listingType && listingType !== 'all') {
      where.listingType = listingType
    }

    if (paymentToken && paymentToken !== 'all') {
      where.paymentToken = paymentToken
    }

    let orderBy: any = { createdAt: 'desc' }
    switch (sort) {
      case 'price_asc':  orderBy = { startPrice: 'asc' }; break
      case 'price_desc': orderBy = { startPrice: 'desc' }; break
      case 'newest':     orderBy = { createdAt: 'desc' }; break
      case 'length_asc': orderBy = { usernameLength: 'asc' }; break
      case 'length_desc': orderBy = { usernameLength: 'desc' }; break
    }

    const [listings, total] = await Promise.all([
      prisma.marketplaceListing.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        include: {
          bids: { where: { status: 'ACTIVE' }, orderBy: { amount: 'desc' }, take: 1 },
          _count: { select: { bids: true } },
        },
      }),
      prisma.marketplaceListing.count({ where }),
    ])

    res.json({ listings, total })
  } catch (err: any) {
    console.error('[marketplace] listings error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/listings/:id
 * Single listing with all bids.
 */
router.get('/listings/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const listing = await prisma.marketplaceListing.findUnique({
      where: { id },
      include: {
        bids: { orderBy: { createdAt: 'desc' } },
        sale: true,
      },
    })

    if (!listing) return res.status(404).json({ error: 'Listing not found' })
    res.json(listing)
  } catch (err: any) {
    console.error('[marketplace] listing detail error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/listings/token/:tokenId
 * Active listing for a specific token.
 */
router.get('/listings/token/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId)
    const listing = await prisma.marketplaceListing.findFirst({
      where: { tokenId, status: 'ACTIVE' },
      include: { bids: { where: { status: 'ACTIVE' }, orderBy: { amount: 'desc' } } },
    })

    res.json(listing || null)
  } catch (err: any) {
    console.error('[marketplace] token listing error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/sales
 * Recent completed sales.
 */
router.get('/sales', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const [sales, total] = await Promise.all([
      prisma.marketplaceSale.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceSale.count(),
    ])

    res.json({ sales, total })
  } catch (err: any) {
    console.error('[marketplace] sales error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/sales/stats
 * Aggregate volume and count.
 */
router.get('/sales/stats', async (req, res) => {
  try {
    const totalSales = await prisma.marketplaceSale.count()
    const sales = await prisma.marketplaceSale.findMany({
      select: { price: true, paymentToken: true },
    })

    // Group volume by payment token
    const volumeByToken: Record<string, string> = {}
    for (const s of sales) {
      const current = BigInt(volumeByToken[s.paymentToken] || '0')
      volumeByToken[s.paymentToken] = (current + BigInt(s.price)).toString()
    }

    res.json({ totalSales, volumeByToken })
  } catch (err: any) {
    console.error('[marketplace] sales stats error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/bids/:address
 * All bids by a given address.
 */
router.get('/bids/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase()
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const [bids, total] = await Promise.all([
      prisma.marketplaceBid.findMany({
        where: { bidder: address },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { listing: true },
      }),
      prisma.marketplaceBid.count({ where: { bidder: address } }),
    ])

    res.json({ bids, total })
  } catch (err: any) {
    console.error('[marketplace] bids error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/listings/:id/sold
 * Optimistically mark a listing as sold after a successful buy tx.
 * The indexer will confirm it later with the actual Sale event.
 */
router.post('/listings/:id/sold', async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { txHash, buyer } = req.body

    if (!txHash || !buyer) {
      return res.status(400).json({ error: 'txHash and buyer required' })
    }

    // Validate txHash format (0x + 64 hex chars) and buyer address (0x + 40 hex chars)
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Invalid transaction hash format' })
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      return res.status(400).json({ error: 'Invalid buyer address format' })
    }

    const listing = await prisma.marketplaceListing.findUnique({ where: { id } })
    if (!listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.status !== 'ACTIVE') return res.json({ ok: true }) // already updated

    await prisma.marketplaceListing.update({
      where: { id },
      data: { status: 'SOLD' },
    })

    // Also create a sale record so it shows up immediately
    await prisma.marketplaceSale.upsert({
      where: { listingId: listing.id },
      update: {},
      create: {
        listingId: listing.id,
        buyer: buyer.toLowerCase(),
        seller: listing.seller,
        tokenId: listing.tokenId,
        price: listing.startPrice,
        paymentToken: listing.paymentToken,
        username: listing.username,
        txHash,
      },
    })

    // Update the user's owner address to the buyer
    await prisma.user.updateMany({
      where: { tokenId: listing.tokenId },
      data: { address: buyer.toLowerCase() },
    })

    console.log(`[marketplace] Listing ${id} marked as sold, owner updated to ${buyer} (optimistic, tx: ${txHash})`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] mark sold error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/listings/seller/:address
 * All listings by a seller.
 */
router.get('/listings/seller/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase()
    const status = req.query.status as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const where: any = { seller: address }
    if (status) where.status = status

    const [listings, total] = await Promise.all([
      prisma.marketplaceListing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceListing.count({ where }),
    ])

    res.json({ listings, total })
  } catch (err: any) {
    console.error('[marketplace] seller listings error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ============================================
// OFFERS
// ============================================

/**
 * GET /api/marketplace/offers/token/:tokenId
 * Active offers for a specific token.
 */
router.get('/offers/token/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId)
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const [offers, total] = await Promise.all([
      prisma.marketplaceOffer.findMany({
        where: { tokenId, status: 'ACTIVE' },
        orderBy: { amount: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceOffer.count({ where: { tokenId, status: 'ACTIVE' } }),
    ])

    res.json({ offers, total })
  } catch (err: any) {
    console.error('[marketplace] token offers error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/offers/received/:address
 * All active offers targeting tokens owned by a given address.
 */
router.get('/offers/received/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase()
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const offset = parseInt(req.query.offset as string) || 0

    // Find all tokenIds owned by this address
    const ownedUsers = await prisma.user.findMany({
      where: { address: { equals: address, mode: 'insensitive' } },
      select: { tokenId: true },
    })
    const tokenIds = ownedUsers.map(u => u.tokenId)

    if (tokenIds.length === 0) {
      return res.json({ offers: [], total: 0 })
    }

    const [offers, total] = await Promise.all([
      prisma.marketplaceOffer.findMany({
        where: { tokenId: { in: tokenIds }, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceOffer.count({ where: { tokenId: { in: tokenIds }, status: 'ACTIVE' } }),
    ])

    res.json({ offers, total })
  } catch (err: any) {
    console.error('[marketplace] received offers error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/offers/address/:address
 * All active offers made by a given address.
 */
router.get('/offers/address/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase()
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const [offers, total] = await Promise.all([
      prisma.marketplaceOffer.findMany({
        where: { offerer: address, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceOffer.count({ where: { offerer: address, status: 'ACTIVE' } }),
    ])

    res.json({ offers, total })
  } catch (err: any) {
    console.error('[marketplace] address offers error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/:offerId/accepted
 * Optimistically mark an offer as accepted after a successful accept tx.
 */
router.post('/offers/:offerId/accepted', async (req, res) => {
  try {
    const offerId = parseInt(req.params.offerId)
    const { txHash, buyer } = req.body

    if (!txHash || !buyer) {
      return res.status(400).json({ error: 'txHash and buyer required' })
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Invalid transaction hash format' })
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      return res.status(400).json({ error: 'Invalid buyer address format' })
    }

    const offer = await prisma.marketplaceOffer.findUnique({ where: { offerId } })
    if (!offer) return res.status(404).json({ error: 'Offer not found' })
    if (offer.status !== 'ACTIVE') return res.json({ ok: true })

    await prisma.marketplaceOffer.update({
      where: { offerId },
      data: { status: 'ACCEPTED' },
    })

    // Update the user's owner address to the buyer
    await prisma.user.updateMany({
      where: { tokenId: offer.tokenId },
      data: { address: buyer.toLowerCase() },
    })

    console.log(`[marketplace] Offer ${offerId} marked as accepted, owner updated to ${buyer} (optimistic, tx: ${txHash})`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] accept offer error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/:offerId/cancelled
 * Optimistically mark an offer as cancelled after a successful cancel tx.
 */
router.post('/offers/:offerId/cancelled', async (req, res) => {
  try {
    const offerId = parseInt(req.params.offerId)
    const { txHash } = req.body

    const offer = await prisma.marketplaceOffer.findUnique({ where: { offerId } })
    if (!offer) return res.status(404).json({ error: 'Offer not found' })
    if (offer.status !== 'ACTIVE') return res.json({ ok: true })

    await prisma.marketplaceOffer.update({
      where: { offerId },
      data: { status: 'CANCELLED' },
    })

    console.log(`[marketplace] Offer ${offerId} marked as cancelled (optimistic, tx: ${txHash})`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] cancel offer error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/offers/unseen-count
 * Count of received offers created after the user's lastViewedOffersAt.
 * Authenticated: requires session with the given userId.
 */
router.get('/offers/unseen-count', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined }), async (req, res) => {
  try {
    const userId = parseInt(req.query.userId as string)
    if (!userId || isNaN(userId)) return res.status(400).json({ error: 'userId required' })

    const user = await prisma.user.findUnique({
      where: { tokenId: userId },
      select: { address: true, lastViewedOffersAt: true },
    })
    if (!user) return res.json({ count: 0 })

    // Find all tokenIds owned by this address
    const ownedUsers = await prisma.user.findMany({
      where: { address: { equals: user.address, mode: 'insensitive' } },
      select: { tokenId: true },
    })
    const tokenIds = ownedUsers.map(u => u.tokenId)

    if (tokenIds.length === 0) return res.json({ count: 0 })

    const where: any = { tokenId: { in: tokenIds }, status: 'ACTIVE' }
    if (user.lastViewedOffersAt) {
      where.createdAt = { gt: user.lastViewedOffersAt }
    }

    const count = await prisma.marketplaceOffer.count({ where })
    res.json({ count })
  } catch (err: any) {
    console.error('[marketplace] unseen count error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/mark-seen
 * Mark offers as seen by updating the user's lastViewedOffersAt.
 * Authenticated: requires session with the given userId.
 */
router.post('/offers/mark-seen', requireAuth({ field: 'userId' }), async (req, res) => {
  try {
    const { userId } = req.body
    if (!userId) return res.status(400).json({ error: 'userId required' })

    await prisma.user.update({
      where: { tokenId: parseInt(userId) },
      data: { lastViewedOffersAt: new Date() },
    })

    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] mark seen error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/:id/dismiss
 * Dismiss/deny an offer by hiding its associated notifications.
 * Authenticated: the caller must own the username that the offer targets.
 */
router.post('/offers/:id/dismiss', requireAuth({ lookup: async (req) => {
  const offerId = parseInt(req.params.id)
  const offer = await prisma.marketplaceOffer.findFirst({ where: { id: offerId } })
  if (!offer) return undefined
  // Return the tokenId of the target username — requireAuth will verify the session owns it
  return offer.tokenId
}}), async (req, res) => {
  try {
    const offerId = parseInt(req.params.id)

    // Hide all OFFER notifications linked to this offer for the authenticated user
    await prisma.notification.updateMany({
      where: {
        offerId,
        type: 'OFFER',
        hidden: false,
      },
      data: { hidden: true },
    })

    console.log(`[marketplace] Offer ${offerId} dismissed (notifications hidden)`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] offer dismiss error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/notify
 * Notify the username owner about a new offer.
 * Authenticated: the caller must own senderTokenId in their session.
 * Verifies:
 *   1. Session authorizes senderTokenId (via requireAuth)
 *   2. Sender's DB address matches the offer's offerer address
 *   3. Session's authorized wallet addresses include the offerer address
 * Accepts txHash to look up the offer (since frontend doesn't know the on-chain offerId).
 * Retries internally if the indexer hasn't processed the event yet.
 */
router.post('/offers/notify', requireAuth({ field: 'senderTokenId' }), async (req, res) => {
  try {
    const { senderTokenId, txHash } = req.body

    if (!senderTokenId || !txHash) {
      return res.status(400).json({ error: 'senderTokenId and txHash required' })
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Invalid transaction hash format' })
    }

    const senderTid = parseInt(senderTokenId)

    // Verify the sender exists
    const sender = await prisma.user.findUnique({ where: { tokenId: senderTid } })
    if (!sender) return res.status(404).json({ error: 'Sender not found' })

    // Verify the session authorizes an address matching the sender
    const sessionAddresses = req.sessionData?.authorizedAddresses || []
    if (!sessionAddresses.some(addr => addr.toLowerCase() === sender.address.toLowerCase())) {
      return res.status(403).json({ error: 'Session wallet does not match sender' })
    }

    // Look up the offer by txHash — may need to wait for indexer
    let offer = await prisma.marketplaceOffer.findFirst({ where: { txHash } })

    if (!offer) {
      // Retry a few times with short delays for indexer lag
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 3000))
        offer = await prisma.marketplaceOffer.findFirst({ where: { txHash } })
        if (offer) break
      }
    }

    if (!offer) return res.status(404).json({ error: 'Offer not found (indexer may not have processed it yet)' })

    // Verify sender's address matches the offerer on the offer
    if (sender.address.toLowerCase() !== offer.offerer.toLowerCase()) {
      return res.status(403).json({ error: 'Sender address does not match offer offerer' })
    }

    // Find the username owner to notify
    const owner = await prisma.user.findUnique({ where: { tokenId: offer.tokenId } })
    if (!owner) return res.json({ ok: true }) // No owner to notify

    // Don't notify yourself
    if (owner.tokenId === senderTid) return res.json({ ok: true })

    // Check for duplicate notification
    const existing = await prisma.notification.findFirst({
      where: {
        userId: owner.tokenId,
        actorId: senderTid,
        type: 'OFFER',
        offerId: offer.id,
      },
    })

    if (!existing) {
      await prisma.notification.create({
        data: {
          userId: owner.tokenId,
          actorId: senderTid,
          type: 'OFFER',
          offerId: offer.id,
        },
      })
    }

    console.log(`[marketplace] Offer notification sent: actor=${senderTid} -> owner=${owner.tokenId} (tx: ${txHash})`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] offer notify error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/report-failure
 * Log an offer accept/cancel failure for admin visibility.
 * Intentionally unauthenticated — any user can report their own failure.
 * Stored as a BugReport with type="offer-failure".
 */
router.post('/offers/report-failure', async (req, res) => {
  try {
    const { offerId, stage, error } = req.body
    if (!offerId || !stage) {
      return res.status(400).json({ error: 'offerId and stage required' })
    }

    const description = `Offer ${offerId} failed at stage "${stage}": ${String(error).slice(0, 2000)}`

    await prisma.bugReport.create({
      data: {
        type: 'offer-failure',
        description,
      },
    })

    console.log(`[marketplace] Offer failure reported: offerId=${offerId} stage=${stage}`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] report failure error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
