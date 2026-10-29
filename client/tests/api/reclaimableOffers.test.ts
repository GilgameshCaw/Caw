// findReclaimableOffers backs GET /api/marketplace/offers/reclaimable/:address:
// the offers an address made that the indexer has marked EXPIRED. On chain
// they are still active, with their funds escrowed, until cancelOffer is
// called.
//
// Integration-style: runs the real function against a real database.
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../src/prismaClient'
import { findReclaimableOffers } from '../../src/api/util/reclaimableOffers'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')
const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const IDS = [95001, 95002, 95003, 95004, 95005, 95006]

type Status = 'ACTIVE' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED'
const seed = (offerId: number, offerer: string, status: Status, expiry: string) =>
  prisma.marketplaceOffer.create({
    data: {
      offerId, tokenId: 17, offerer, paymentToken: 'CAW', paymentAddress: '0xdef',
      amount: '10000000000000000000', expiry: new Date(expiry), username: 'someone', status,
    },
  })
const ids = (r: { offers: { offerId: number }[] }) => r.offers.map(o => o.offerId)

describe('findReclaimableOffers', () => {
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

  it('returns only the EXPIRED offers of that address', async () => {
    await seed(IDS[0], ME, 'EXPIRED', '2026-09-02T00:00:00Z')
    await seed(IDS[1], ME, 'ACTIVE', '2027-01-01T00:00:00Z')
    await seed(IDS[2], ME, 'ACCEPTED', '2026-09-01T00:00:00Z')
    await seed(IDS[3], ME, 'CANCELLED', '2026-09-01T00:00:00Z')
    await seed(IDS[4], OTHER, 'EXPIRED', '2026-09-02T00:00:00Z')
    const r = await findReclaimableOffers(prisma, ME, 50, 0)
    expect(ids(r)).to.deep.equal([IDS[0]])
    expect(r.total).to.equal(1)
    expect(r.hasMore).to.equal(false)
  })

  it('matches the address whatever its case', async () => {
    await seed(IDS[0], ME, 'EXPIRED', '2026-09-02T00:00:00Z')
    const r = await findReclaimableOffers(prisma, ME.toUpperCase().replace('0X', '0x'), 50, 0)
    expect(ids(r)).to.deep.equal([IDS[0]])
  })

  it('lists the most recently expired first and pages', async () => {
    await seed(IDS[0], ME, 'EXPIRED', '2026-08-01T00:00:00Z')
    await seed(IDS[1], ME, 'EXPIRED', '2026-09-01T00:00:00Z')
    await seed(IDS[2], ME, 'EXPIRED', '2026-07-01T00:00:00Z')
    expect(ids(await findReclaimableOffers(prisma, ME, 50, 0))).to.deep.equal([IDS[1], IDS[0], IDS[2]])
    const page = await findReclaimableOffers(prisma, ME, 1, 1)
    expect(ids(page)).to.deep.equal([IDS[0]])
    expect(page.total).to.equal(3)
    expect(page.hasMore).to.equal(true)
    expect((await findReclaimableOffers(prisma, ME, 1, 2)).hasMore).to.equal(false)
  })

  it('returns an empty list for an address with no expired offers', async () => {
    expect(await findReclaimableOffers(prisma, OTHER, 50, 0)).to.deep.equal({ offers: [], total: 0, hasMore: false })
  })
})
