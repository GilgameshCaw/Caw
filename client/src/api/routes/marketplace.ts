import { Router } from 'express'
import { prisma } from '../../prismaClient'

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

export default router
