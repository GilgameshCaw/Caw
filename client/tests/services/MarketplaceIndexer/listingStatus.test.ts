// markListingCancelled applies ListingCancelled to a MarketplaceListing row.
//
// Integration-style: runs the real function against a real database.
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../../src/prismaClient'
import { markListingCancelled } from '../../../src/services/MarketplaceIndexerService/listingStatus'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')
const IDS = [96001, 96002, 96003, 96004]

type Status = 'ACTIVE' | 'SOLD' | 'CANCELLED' | 'EXPIRED'
const seed = (listingId: number, status: Status) =>
  prisma.marketplaceListing.create({
    data: {
      listingId, tokenId: 54, seller: '0xabc', listingType: 'ENGLISH_AUCTION', paymentToken: 'ETH',
      paymentAddress: '0x0', startPrice: '1000000000000000', startTime: new Date('2026-09-22T13:00:00Z'),
      endTime: new Date('2026-09-22T14:05:36Z'), username: 'someone', usernameLength: 7, status,
    },
  })
const statusOf = async (listingId: number) =>
  (await prisma.marketplaceListing.findUniqueOrThrow({ where: { listingId } })).status

describe('MarketplaceIndexer / markListingCancelled', () => {
  before(function () { if (!ON_TEST_DB) this.skip() })
  beforeEach(async () => {
    if (!ON_TEST_DB) return
    await prisma.marketplaceListing.deleteMany({ where: { listingId: { in: IDS } } })
  })
  after(async () => {
    if (!ON_TEST_DB) return
    await prisma.marketplaceListing.deleteMany({ where: { listingId: { in: IDS } } })
    await prisma.$disconnect()
  })

  it('moves an ACTIVE listing to CANCELLED', async () => {
    await seed(IDS[0], 'ACTIVE')
    expect((await markListingCancelled(prisma, IDS[0])).count).to.equal(1)
    expect(await statusOf(IDS[0])).to.equal('CANCELLED')
  })

  it('moves an EXPIRED listing (an ended auction with no bids) to CANCELLED', async () => {
    await seed(IDS[0], 'EXPIRED')
    expect((await markListingCancelled(prisma, IDS[0])).count).to.equal(1)
    expect(await statusOf(IDS[0])).to.equal('CANCELLED')
  })

  it('leaves SOLD and CANCELLED listings as they are', async () => {
    await seed(IDS[0], 'SOLD'); await seed(IDS[1], 'CANCELLED')
    expect((await markListingCancelled(prisma, IDS[0])).count).to.equal(0)
    expect((await markListingCancelled(prisma, IDS[1])).count).to.equal(0)
    expect(await statusOf(IDS[0])).to.equal('SOLD')
    expect(await statusOf(IDS[1])).to.equal('CANCELLED')
  })

  it('only touches the listing named by the event', async () => {
    await seed(IDS[0], 'EXPIRED'); await seed(IDS[1], 'EXPIRED'); await seed(IDS[2], 'ACTIVE')
    await markListingCancelled(prisma, IDS[0])
    expect(await statusOf(IDS[1])).to.equal('EXPIRED')
    expect(await statusOf(IDS[2])).to.equal('ACTIVE')
  })

  it('does nothing for a listing the indexer has not seen', async () => {
    expect((await markListingCancelled(prisma, IDS[3])).count).to.equal(0)
  })
})
