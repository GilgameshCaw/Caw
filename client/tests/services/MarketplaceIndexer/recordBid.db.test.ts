// recordBid against a real database: the same cases as recordBid.test.ts, but
// through Prisma's own updateMany / upsert on the (listingId, bidder, txHash)
// unique key instead of an in-memory stand-in.
//
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../../src/prismaClient'
import { recordBid } from '../../../src/services/MarketplaceIndexerService/recordBid'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')
const LISTINGS = [99901, 99902]

async function newListing(listingId: number) {
  return prisma.marketplaceListing.create({
    data: {
      listingId, tokenId: 54, seller: '0xs', listingType: 'ENGLISH_AUCTION', paymentToken: 'ETH', paymentAddress: '0x0',
      startPrice: '1', startTime: new Date(), endTime: new Date(Date.now() + 3600e3), username: 'u', usernameLength: 1,
    },
  })
}
const bid = (listingRowId: number, bidder: string, n: number) => ({
  listingRowId, bidder, amount: String(n * 100), txHash: `0xtx${n}`,
})
const states = async (listingRowId: number) =>
  (await prisma.marketplaceBid.findMany({ where: { listingId: listingRowId }, orderBy: { id: 'asc' } }))
    .map(b => `${b.txHash}:${b.status}`)

describe('MarketplaceIndexer / recordBid (real database)', () => {
  before(function () { if (!ON_TEST_DB) this.skip() })
  const wipe = async () => {
    await prisma.marketplaceBid.deleteMany({ where: { listing: { listingId: { in: LISTINGS } } } })
    await prisma.marketplaceListing.deleteMany({ where: { listingId: { in: LISTINGS } } })
  }
  beforeEach(async () => { if (ON_TEST_DB) await wipe() })
  after(async () => {
    if (!ON_TEST_DB) return
    await wipe()
    await prisma.$disconnect()
  })

  it('a new bid is ACTIVE and demotes the previous one', async () => {
    const l = await newListing(LISTINGS[0])
    expect(await recordBid(prisma, bid(l.id, '0xa', 1))).to.equal(true)
    expect(await recordBid(prisma, bid(l.id, '0xb', 2))).to.equal(true)
    expect(await states(l.id)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('replaying the whole range leaves the highest bid ACTIVE and adds no rows', async () => {
    const l = await newListing(LISTINGS[0])
    await recordBid(prisma, bid(l.id, '0xa', 1))
    await recordBid(prisma, bid(l.id, '0xb', 2))
    expect(await recordBid(prisma, bid(l.id, '0xa', 1))).to.equal(false)
    expect(await recordBid(prisma, bid(l.id, '0xb', 2))).to.equal(false)
    expect(await states(l.id)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('a replay that reaches a bid not stored yet demotes the stored one', async () => {
    const l = await newListing(LISTINGS[0])
    await recordBid(prisma, bid(l.id, '0xa', 1)) // the first pass stopped after bid 1
    expect(await recordBid(prisma, bid(l.id, '0xa', 1))).to.equal(false)
    expect(await recordBid(prisma, bid(l.id, '0xb', 2))).to.equal(true)
    expect(await states(l.id)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('a replay does not touch a bid that has since been marked WON', async () => {
    const l = await newListing(LISTINGS[0])
    await recordBid(prisma, bid(l.id, '0xa', 1))
    await recordBid(prisma, bid(l.id, '0xb', 2))
    await prisma.marketplaceBid.updateMany({ where: { listingId: l.id, txHash: '0xtx2' }, data: { status: 'WON' } })
    await recordBid(prisma, bid(l.id, '0xa', 1))
    await recordBid(prisma, bid(l.id, '0xb', 2))
    expect(await states(l.id)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:WON'])
  })

  it('does not touch the bids of another listing', async () => {
    const l1 = await newListing(LISTINGS[0])
    const l2 = await newListing(LISTINGS[1])
    await recordBid(prisma, bid(l1.id, '0xa', 1))
    await recordBid(prisma, bid(l2.id, '0xb', 2))
    expect(await states(l1.id)).to.deep.equal(['0xtx1:ACTIVE'])
    expect(await states(l2.id)).to.deep.equal(['0xtx2:ACTIVE'])
  })
})
