// closeOffer applies OfferAccepted / OfferCancelled to a MarketplaceOffer row.
//
// Integration-style: runs the real closeOffer against a real database.
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../../src/prismaClient'
import { closeOffer } from '../../../src/services/MarketplaceIndexerService/offerStatus'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')
const IDS = [94001, 94002, 94003, 94004, 94005]

type Status = 'ACTIVE' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED'

async function seed(offerId: number, status: Status) {
  await prisma.marketplaceOffer.create({
    data: {
      offerId, tokenId: 17, offerer: '0xabc', paymentToken: 'CAW', paymentAddress: '0xdef',
      amount: '10000000000000000000', expiry: new Date('2026-09-02T04:12:48Z'), username: 'someone', status,
    },
  })
}
const statusOf = async (offerId: number) =>
  (await prisma.marketplaceOffer.findUniqueOrThrow({ where: { offerId } })).status

describe('MarketplaceIndexer / closeOffer', () => {
  before(function () { if (!ON_TEST_DB) this.skip() })
  beforeEach(async () => {
    if (!ON_TEST_DB) return
    await prisma.marketplaceOffer.deleteMany({ where: { offerId: { in: IDS } } })
  })
  after(async () => {
    if (!ON_TEST_DB) return
    await prisma.marketplaceOffer.deleteMany({ where: { offerId: { in: IDS } } })
    await prisma.$disconnect()
  })

  it('moves an ACTIVE offer to ACCEPTED or CANCELLED', async () => {
    await seed(IDS[0], 'ACTIVE'); await seed(IDS[1], 'ACTIVE')
    expect((await closeOffer(prisma, IDS[0], 'ACCEPTED')).count).to.equal(1)
    expect((await closeOffer(prisma, IDS[1], 'CANCELLED')).count).to.equal(1)
    expect(await statusOf(IDS[0])).to.equal('ACCEPTED')
    expect(await statusOf(IDS[1])).to.equal('CANCELLED')
  })

  it('moves an EXPIRED offer on when it is cancelled (refunded) or accepted on chain', async () => {
    await seed(IDS[0], 'EXPIRED'); await seed(IDS[1], 'EXPIRED')
    expect((await closeOffer(prisma, IDS[0], 'CANCELLED')).count).to.equal(1)
    expect((await closeOffer(prisma, IDS[1], 'ACCEPTED')).count).to.equal(1)
    expect(await statusOf(IDS[0])).to.equal('CANCELLED')
    expect(await statusOf(IDS[1])).to.equal('ACCEPTED')
  })

  it('leaves ACCEPTED and CANCELLED offers as they are', async () => {
    await seed(IDS[0], 'ACCEPTED'); await seed(IDS[1], 'CANCELLED')
    expect((await closeOffer(prisma, IDS[0], 'CANCELLED')).count).to.equal(0)
    expect((await closeOffer(prisma, IDS[1], 'ACCEPTED')).count).to.equal(0)
    expect(await statusOf(IDS[0])).to.equal('ACCEPTED')
    expect(await statusOf(IDS[1])).to.equal('CANCELLED')
  })

  it('only touches the offer named by the event', async () => {
    await seed(IDS[0], 'EXPIRED'); await seed(IDS[1], 'EXPIRED'); await seed(IDS[2], 'ACTIVE')
    await closeOffer(prisma, IDS[0], 'CANCELLED')
    expect(await statusOf(IDS[1])).to.equal('EXPIRED')
    expect(await statusOf(IDS[2])).to.equal('ACTIVE')
  })

  it('does nothing for an offer the indexer has not seen', async () => {
    expect((await closeOffer(prisma, IDS[4], 'CANCELLED')).count).to.equal(0)
  })
})
