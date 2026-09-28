/**
 * Regression test for the AUCTION_WON notification duplication bug.
 *
 * MarketplaceIndexerService's poll loop can re-scan the same on-chain
 * range on retry (see the OUTBID handler's own comment on this file for
 * background). Before this fix, the AUCTION_WON handler unconditionally
 * created both the MarketplaceSale row and its notification on every
 * scan, so re-processing the same AuctionWon event sent the winner a
 * second (or Nth) duplicate notification.
 *
 * This test does not exercise the real ethers/event-polling machinery
 * (that would require mocking the L1 provider and Contract). Instead it
 * reproduces the exact Prisma sequence the fixed handler runs — findUnique
 * -> upsert -> saleWasNew gate -> createNotificationWithGroup — and calls
 * it twice for the same event, which is the scenario the fix protects
 * against.
 *
 * SKIPS unless DATABASE_URL points at a caw_test_* database. Example
 * (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_auctionwon \
 *   npx mocha --import=tsx --exit tests/services/marketplaceAuctionWonDedup.test.ts
 *
 * The schema has to exist in that database (the project's usual schema setup).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990200
const WINNER_TOKEN_ID = BASE
const SELLER_TOKEN_ID = BASE + 1
const LISTING_ID = BASE

;(HAS_TEST_DB ? describe : describe.skip)('AUCTION_WON notification is not duplicated on re-scan', function () {
  this.timeout(30000)

  // Bound in `before` via dynamic import (see header).
  let prisma: typeof import('../../src/prismaClient').prisma
  let createNotificationWithGroup: typeof import('../../src/services/NotificationService').createNotificationWithGroup

  const winnerAddress = '0x1111111111111111111111111111111111aaaa'
  const sellerAddress = '0x2222222222222222222222222222222222bbbb'
  const txHash = '0xauctionwon_dedup_test_txhash'
  const price = '1000000000000000000'

  let listingRowId = 0

  before(async () => {
    ;({ prisma } = await import('../../src/prismaClient'))
    ;({ createNotificationWithGroup } = await import('../../src/services/NotificationService'))

    await prisma.user.create({
      data: {
        id: WINNER_TOKEN_ID,
        tokenId: WINNER_TOKEN_ID,
        username: 'aw_test_winner',
        address: winnerAddress,
      },
    })
    await prisma.user.create({
      data: {
        id: SELLER_TOKEN_ID,
        tokenId: SELLER_TOKEN_ID,
        username: 'aw_test_seller',
        address: sellerAddress,
      },
    })

    const listing = await prisma.marketplaceListing.create({
      data: {
        listingId: LISTING_ID,
        tokenId: WINNER_TOKEN_ID,
        seller: sellerAddress,
        listingType: 'ENGLISH_AUCTION',
        paymentToken: 'ETH',
        paymentAddress: '0x0000000000000000000000000000000000dEaD',
        startPrice: price,
        startTime: new Date(),
        highestBid: price,
        highestBidder: winnerAddress,
        username: 'aw_test_winner',
        usernameLength: 'aw_test_winner'.length,
      },
    })
    listingRowId = listing.id
  })

  after(async () => {
    await prisma.notification.deleteMany({ where: { userId: WINNER_TOKEN_ID } })
    await prisma.notificationGroup.deleteMany({ where: { userId: WINNER_TOKEN_ID } })
    await prisma.marketplaceSale.deleteMany({ where: { listingId: listingRowId } })
    await prisma.marketplaceListing.deleteMany({ where: { listingId: LISTING_ID } })
    await prisma.user.deleteMany({ where: { tokenId: { in: [WINNER_TOKEN_ID, SELLER_TOKEN_ID] } } })
    await prisma.$disconnect()
  })

  // Mirrors the fixed handler in MarketplaceIndexerService/index.ts exactly.
  async function processAuctionWonEvent() {
    const listing = await prisma.marketplaceListing.findUnique({ where: { id: listingRowId } })
    if (!listing) throw new Error('listing not found')

    const beforeSale = await prisma.marketplaceSale.findUnique({
      where: { listingId: listing.id },
      select: { id: true },
    })
    const saleWasNew = !beforeSale

    await prisma.marketplaceSale.upsert({
      where: { listingId: listing.id },
      update: {},
      create: {
        listingId: listing.id,
        buyer: winnerAddress,
        seller: listing.seller,
        tokenId: listing.tokenId,
        price,
        paymentToken: listing.paymentToken,
        username: listing.username,
        txHash,
      },
    })

    if (saleWasNew) {
      const winnerUser = await prisma.user.findFirst({
        where: { address: { equals: winnerAddress, mode: 'insensitive' } },
        select: { tokenId: true },
      })
      const sellerUser = await prisma.user.findFirst({
        where: { address: { equals: listing.seller, mode: 'insensitive' } },
        select: { tokenId: true },
      })
      if (winnerUser) {
        await createNotificationWithGroup(prisma, {
          userId: winnerUser.tokenId,
          actorId: sellerUser?.tokenId ?? winnerUser.tokenId,
          type: 'AUCTION_WON',
          actionPayload: { listingId: LISTING_ID, username: listing.username, tokenId: listing.tokenId },
        })
      }
    }
  }

  it('creates exactly one MarketplaceSale row and one notification across two scans of the same event', async () => {
    await processAuctionWonEvent()
    await processAuctionWonEvent() // simulates a checkpoint re-scan hitting the same event again

    const sales = await prisma.marketplaceSale.findMany({ where: { listingId: listingRowId } })
    expect(sales).to.have.length(1)

    const notifications = await prisma.notification.findMany({
      where: { userId: WINNER_TOKEN_ID, type: 'AUCTION_WON' },
    })
    expect(notifications).to.have.length(1)
  })
})
