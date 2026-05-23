import { Router } from 'express'
import Redis from 'ioredis'
import { prisma } from '../../prismaClient'
import { requireAuth } from '../middleware/auth'
import { createNotificationWithGroup } from '../../services/NotificationService'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

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

    // Hide ended auctions from the active feed even though their on-chain
    // status hasn't flipped yet (the seller / winner needs to claim before
    // the contract emits the finalize event the indexer keys off). Without
    // this filter, an auction that ended a week ago with a winning bid
    // keeps appearing in "active listings" because nobody settled it.
    if (status === 'ACTIVE') {
      where.OR = [
        { listingType: { not: 'ENGLISH_AUCTION' } },
        { endTime: null },
        { endTime: { gt: new Date() } },
      ]
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
 *
 * Pushes aggregation to Postgres via SUM with a NUMERIC cast — the price
 * column is stored as a string (BigInt-shaped), so Prisma's _sum aggregate
 * can't be used directly. Previous implementation loaded every sale row
 * into application memory and summed in JS, which was a full-table scan
 * + large response shape at scale (OOM-adjacent). Audit fix 2026-05-13.
 *
 * NUMERIC handles arbitrary-precision integers natively in Postgres; we
 * cast back to text for the response so the BigInt math survives the
 * JSON serialization.
 */
router.get('/sales/stats', async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<Array<{ paymentToken: string; count: bigint; volume: string }>>`
      SELECT
        "paymentToken",
        COUNT(*)::bigint AS count,
        SUM("price"::numeric)::text AS volume
      FROM "MarketplaceSale"
      GROUP BY "paymentToken"
    `

    const volumeByToken: Record<string, string> = {}
    let totalSales = 0
    for (const r of rows) {
      totalSales += Number(r.count)
      volumeByToken[r.paymentToken] = r.volume ?? '0'
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
 * GET /api/marketplace/refunds/:address
 * Bids whose escrowed funds are claimable by the given address: anything in
 * OUTBID status (covers both "outbid by a higher bid" and "auction was
 * cancelled / reclaimed", since BidReclaimed maps the indexer status the
 * same way). The frontend should treat this as a list of *candidate*
 * refunds and confirm the actual amount on-chain via pendingReturns(...)
 * before showing UI numbers — chain is the source of truth.
 */
router.get('/refunds/:address', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase()
    // Paginated: matches the pattern in /bids/:address below. A heavy bidder
    // with thousands of OUTBID rows was previously loading them all in one
    // shot. Audit fix 2026-05-13.
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
    const offset = parseInt(req.query.offset as string) || 0
    const [bids, total] = await Promise.all([
      prisma.marketplaceBid.findMany({
        where: { bidder: address, status: 'OUTBID' },
        orderBy: { createdAt: 'desc' },
        include: { listing: true },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceBid.count({ where: { bidder: address, status: 'OUTBID' } }),
    ])
    res.json({ bids, total, hasMore: offset + bids.length < total })
  } catch (err: any) {
    console.error('[marketplace] refunds error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/listings/:id/sold
 * Optimistically mark a listing as sold after a successful buy tx.
 * The indexer will confirm it later with the actual Sale event.
 */
router.post('/listings/:id/sold', requireAuth({ anySession: true }), async (req, res) => {
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

    // Auth: only the buyer (the wallet that just submitted the buy tx)
    // can flip status. This bounds the damage if a stale session reaches
    // here — the worst they can do is mis-flip a listing they themselves
    // are buying. Address ownership is left to MarketplaceIndexerService
    // when it sees the L2 Sale event (~60s).
    const buyerLc = buyer.toLowerCase()
    const authedAddresses = (req.sessionData?.authorizedAddresses || []).map(a => a.toLowerCase())
    if (!authedAddresses.includes(buyerLc)) {
      return res.status(403).json({ error: 'Session is not authorized as the buyer address' })
    }

    const listing = await prisma.marketplaceListing.findUnique({ where: { id } })
    if (!listing) return res.status(404).json({ error: 'Listing not found' })

    // Audit fix 2026-05-09 (Round 5 API HIGH-3): we used to optimistically
    // flip listing.status -> SOLD and upsert a MarketplaceSale row using
    // listing.startPrice (wrong for English auctions) and the user-supplied
    // txHash (unverified). That violated `project_chain_mirrored_status.md`
    // (soft state in chain-mirrored enum) and let any signed-in buyer DoS
    // active listings by falsely marking them sold. Now this endpoint is a
    // logging breadcrumb only; MarketplaceIndexerService handles the real
    // status flip and Sale row insertion from the on-chain Sale event
    // within ~60s.
    console.log(`[marketplace] mark-sold breadcrumb: listing=${id} buyer=${buyerLc} tx=${txHash} (status flip deferred to indexer)`)
    res.json({ ok: true, deferred: true })
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
 * All active offers targeting tokens owned by a given address. Excludes any
 * offers that the targeted token's owner has dismissed (per-token dismissal,
 * stored in MarketplaceOfferDismissal — see POST /offers/:id/dismiss).
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

    // Pull dismissals once and filter inline. The (offerId, userId) unique
    // index makes this cheap; no per-row sub-select. We dismiss against
    // MarketplaceOfferDismissal.userId == the targeted tokenId, mirroring how
    // the dismiss endpoint records them.
    const dismissals = await prisma.marketplaceOfferDismissal.findMany({
      where: { userId: { in: tokenIds } },
      select: { offerId: true },
    })
    const dismissedOfferIds = dismissals.map(d => d.offerId)

    const where = {
      tokenId: { in: tokenIds },
      status: 'ACTIVE' as const,
      ...(dismissedOfferIds.length > 0 ? { id: { notIn: dismissedOfferIds } } : {}),
    }

    const [offers, total] = await Promise.all([
      prisma.marketplaceOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceOffer.count({ where }),
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
router.post('/offers/:offerId/accepted', requireAuth({ anySession: true }), async (req, res) => {
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

    // Auth: only the SELLER (the wallet that just submitted the
    // accept tx) can flip status. Resolve the seller from the token's
    // current owner; require their address is on the session. Bounds
    // damage to "the seller can mis-flip their own offer's status";
    // address update is left to MarketplaceIndexerService.
    const tokenOwner = await prisma.user.findUnique({
      where:  { tokenId: offer.tokenId },
      select: { address: true },
    })
    if (!tokenOwner?.address) {
      return res.status(400).json({ error: 'Token has no owner address on record' })
    }
    const sellerLc = tokenOwner.address.toLowerCase()
    const authedAddresses = (req.sessionData?.authorizedAddresses || []).map(a => a.toLowerCase())
    if (!authedAddresses.includes(sellerLc)) {
      return res.status(403).json({ error: 'Session is not authorized as the seller (current token owner)' })
    }

    // Logging-only — do NOT write status=ACCEPTED optimistically.
    // If the on-chain tx fails the DB row would stay ACCEPTED permanently
    // because the indexer only consumes OfferAccepted events; it has no
    // "ACCEPTED-but-no-matching-event" reconciliation pass.
    // MarketplaceIndexerService handles the OfferAccepted event → that is
    // the canonical state machine for this transition.
    // Pattern mirrors /listings/:id/sold (refactored 2026-05-09 audit HIGH-3).
    console.log('[Marketplace] /offers/:id/accepted called by owner', sellerLc)
    res.status(202).json({ ok: true, message: 'Event will be processed by indexer' })
  } catch (err: any) {
    console.error('[marketplace] accept offer error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/marketplace/offers/:offerId/cancelled
 * Optimistically mark an offer as cancelled after a successful cancel tx.
 */
router.post('/offers/:offerId/cancelled', requireAuth({ anySession: true }), async (req, res) => {
  try {
    const offerId = parseInt(req.params.offerId)
    const { txHash } = req.body

    const offer = await prisma.marketplaceOffer.findUnique({ where: { offerId } })
    if (!offer) return res.status(404).json({ error: 'Offer not found' })
    if (offer.status !== 'ACTIVE') return res.json({ ok: true })

    // Auth: only the offerer can cancel their own offer. (The on-chain
    // contract enforces this — any non-offerer cancel tx will revert.
    // We mirror the same rule here so an unauth caller can't pre-flip
    // the status row to CANCELLED.)
    const offererLc = offer.offerer.toLowerCase()
    const authedAddresses = (req.sessionData?.authorizedAddresses || []).map(a => a.toLowerCase())
    if (!authedAddresses.includes(offererLc)) {
      return res.status(403).json({ error: 'Session is not authorized as the offerer' })
    }

    await prisma.marketplaceOffer.update({
      where: { offerId },
      data: { status: 'CANCELLED' },
    })

    console.log(`[marketplace] Offer ${offerId} marked as cancelled by offerer ${offererLc} (optimistic, tx: ${txHash})`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] cancel offer error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/marketplace/offers/unseen-count
 * Count of ACTIVE received offers. Stays non-zero while any offer is still
 * pending — the badge only clears once each offer is accepted or cancelled
 * (which transitions it out of ACTIVE). Endpoint name kept for FE compat.
 * Authenticated: requires session with the given userId.
 */
router.get('/offers/unseen-count', requireAuth({ lookup: async (req) => Number(req.query.userId) || undefined, verifyOwnership: true }), async (req, res) => {
  try {
    const userId = parseInt(req.query.userId as string)
    if (!userId || isNaN(userId)) return res.status(400).json({ error: 'userId required' })

    const user = await prisma.user.findUnique({
      where: { tokenId: userId },
      select: { address: true },
    })
    if (!user?.address) return res.json({ count: 0 })

    // Find all tokenIds owned by this address
    const ownedUsers = await prisma.user.findMany({
      where: { address: { equals: user.address, mode: 'insensitive' } },
      select: { tokenId: true },
    })
    const tokenIds = ownedUsers.map(u => u.tokenId)

    if (tokenIds.length === 0) return res.json({ count: 0 })

    const count = await prisma.marketplaceOffer.count({
      where: { tokenId: { in: tokenIds }, status: 'ACTIVE' },
    })
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
router.post('/offers/mark-seen', requireAuth({ field: 'userId', verifyOwnership: true }), async (req, res) => {
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
 * Dismiss/deny an offer for the authenticated recipient. Records a per-recipient
 * dismissal row (so the My Offers list and badge can exclude it) and hides the
 * associated OFFER notification. Does NOT touch MarketplaceOffer.status — that
 * column mirrors on-chain state and is re-asserted by MarketplaceIndexer on
 * block-rewind windows. The :id path param is the DB row id; we resolve the
 * target tokenId from it for the auth check.
 */
router.post('/offers/:id/dismiss', requireAuth({ lookup: async (req) => {
  const offerId = parseInt(req.params.id)
  const offer = await prisma.marketplaceOffer.findFirst({ where: { id: offerId } })
  if (!offer) return undefined
  // Return the tokenId of the target username — requireAuth will verify the session owns it
  return offer.tokenId
}, verifyOwnership: true }), async (req, res) => {
  try {
    const offerId = parseInt(req.params.id)
    const offer = await prisma.marketplaceOffer.findFirst({ where: { id: offerId } })
    if (!offer) return res.status(404).json({ error: 'Offer not found' })

    // Idempotent insert — composite (offerId, userId) is unique. The user
    // here is the owner of the targeted username (verified by requireAuth's
    // lookup above against offer.tokenId).
    await prisma.marketplaceOfferDismissal.upsert({
      where: { offerId_userId: { offerId: offer.id, userId: offer.tokenId } },
      update: {},
      create: { offerId: offer.id, userId: offer.tokenId },
    })

    // Hide the OFFER notification too so it doesn't keep nagging
    await prisma.notification.updateMany({
      where: { offerId, type: 'OFFER', hidden: false },
      data: { hidden: true },
    })

    console.log(`[marketplace] Offer ${offerId} dismissed by tokenId=${offer.tokenId}`)
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
router.post('/offers/notify', requireAuth({ field: 'senderTokenId', verifyOwnership: true }), async (req, res) => {
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

    // Look up the offer by txHash. The indexer may not have processed
    // this tx yet, so the offer might not exist for a few seconds.
    //
    // Previously this endpoint blocked the request for up to 15 seconds
    // (5×3s retries) waiting for the indexer. Under load that starved
    // the request pool. Now: return 202 if the offer isn't visible yet
    // and kick off a background retry; the client is already prepared
    // for the notification to arrive asynchronously (the underlying
    // tx + indexer pipeline is async by nature). Audit fix 2026-05-13.
    let offer = await prisma.marketplaceOffer.findFirst({ where: { txHash } })

    if (!offer) {
      // Dedup: SET NX 60s prevents the same txHash from spawning multiple
      // background goroutines (e.g., attacker POSTs same txHash repeatedly).
      const dedupKey = `marketplace:notify:${txHash}`
      const acquired = await redis.set(dedupKey, '1', 'EX', 60, 'NX')
      if (!acquired) {
        return res.status(202).json({ ok: true, status: 'already-processing' })
      }
      // Fire-and-forget background retry. We respond 202 immediately
      // so the client doesn't hold a socket open.
      void backgroundNotifyOnIndex(senderTid, sender.address.toLowerCase(), txHash)
      return res.status(202).json({ ok: true, deferred: true })
    }

    // Verify sender's address matches the offerer on the offer
    if (sender.address.toLowerCase() !== offer.offerer.toLowerCase()) {
      return res.status(403).json({ error: 'Sender address does not match offer offerer' })
    }

    await finalizeOfferNotification(offer, senderTid)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[marketplace] offer notify error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Common notification-emission tail: find the username owner, dedupe,
 * write the Notification row.
 */
async function finalizeOfferNotification(
  offer: { id: number; tokenId: number },
  senderTid: number,
): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { tokenId: offer.tokenId } })
  if (!owner) return
  if (owner.tokenId === senderTid) return
  const existing = await prisma.notification.findFirst({
    where: { userId: owner.tokenId, actorId: senderTid, type: 'OFFER', offerId: offer.id },
  })
  if (!existing) {
    await createNotificationWithGroup(prisma, {
      userId: owner.tokenId, actorId: senderTid, type: 'OFFER', offerId: offer.id,
    })
  }
  console.log(`[marketplace] Offer notification sent: actor=${senderTid} -> owner=${owner.tokenId}`)
}

/**
 * Background retry: poll for the indexed offer for up to ~30s, then
 * emit the notification. Caller has already verified the sender and
 * the txHash format; if the offer never appears, this just gives up.
 */
async function backgroundNotifyOnIndex(
  senderTid: number,
  senderAddress: string,
  txHash: string,
): Promise<void> {
  try {
    const maxAttempts = 10
    const delayMs = 3000
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, delayMs))
      const offer = await prisma.marketplaceOffer.findFirst({ where: { txHash } })
      if (!offer) continue
      if (offer.offerer.toLowerCase() !== senderAddress) {
        // Indexer found a different offerer than the sender; refuse to
        // notify on someone else's behalf even in the background.
        return
      }
      await finalizeOfferNotification(offer, senderTid)
      return
    }
    console.warn(`[marketplace] background notify: offer for ${txHash} never appeared after ${maxAttempts} retries`)
  } catch (err: any) {
    console.error('[marketplace] background notify error:', err)
  }
}

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
