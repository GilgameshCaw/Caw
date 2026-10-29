// findStaleListingCandidates backs GET /api/marketplace/listings/stale/:address:
// the listings an address may need to clear because the token moved away from
// the seller while the listing was open. On chain such a listing stays active
// and keeps the token locked until reclaimListing / reclaimBid is called.
//
// Integration-style: runs the real function against a real database.
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../src/prismaClient'
import { findStaleListingCandidates } from '../../src/api/util/staleListings'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')
const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc'
const TOKENS = [98001, 98002, 98003, 98004, 98005]
const LISTINGS = [98101, 98102, 98103, 98104, 98105, 98106]

type Status = 'ACTIVE' | 'SOLD' | 'CANCELLED' | 'EXPIRED'
const user = (tokenId: number, address: string) =>
  prisma.user.create({ data: { id: tokenId, tokenId, username: `stale${tokenId}`, address } })
const listing = (listingId: number, tokenId: number, seller: string, status: Status, highestBidder: string | null = null) =>
  prisma.marketplaceListing.create({
    data: {
      listingId, tokenId, seller, listingType: 'ENGLISH_AUCTION', paymentToken: 'ETH', paymentAddress: '0x0',
      startPrice: '1000000000000000', startTime: new Date('2026-09-22T13:00:00Z'), endTime: new Date('2026-09-22T14:00:00Z'),
      username: `stale${tokenId}`, usernameLength: 10, status, highestBidder,
    },
  })
const ids = (rows: { listingId: number }[]) => rows.map(r => r.listingId).sort((a, b) => a - b)

describe('findStaleListingCandidates', () => {
  before(function () { if (!ON_TEST_DB) this.skip() })
  const wipe = async () => {
    await prisma.marketplaceListing.deleteMany({ where: { listingId: { in: LISTINGS } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: TOKENS } } })
  }
  beforeEach(async () => { if (ON_TEST_DB) await wipe() })
  after(async () => {
    if (!ON_TEST_DB) return
    await wipe()
    await prisma.$disconnect()
  })

  it('returns a listing by another seller on a token the address owns, whatever its status but SOLD', async () => {
    await user(TOKENS[0], ME); await user(TOKENS[1], ME); await user(TOKENS[2], ME); await user(TOKENS[3], ME)
    await listing(LISTINGS[0], TOKENS[0], SELLER, 'CANCELLED') // what the indexer sets on an external transfer
    await listing(LISTINGS[1], TOKENS[1], SELLER, 'EXPIRED')
    await listing(LISTINGS[2], TOKENS[2], SELLER, 'ACTIVE')
    await listing(LISTINGS[3], TOKENS[3], SELLER, 'SOLD')
    expect(ids(await findStaleListingCandidates(prisma, ME, 50))).to.deep.equal([LISTINGS[0], LISTINGS[1], LISTINGS[2]])
  })

  it('leaves out the address\'s own listings', async () => {
    await user(TOKENS[0], ME)
    await listing(LISTINGS[0], TOKENS[0], ME, 'ACTIVE')
    expect(await findStaleListingCandidates(prisma, ME, 50)).to.deep.equal([])
  })

  it('returns the listings the address is the highest bidder of, by another seller', async () => {
    await user(TOKENS[0], SELLER); await user(TOKENS[1], SELLER); await user(TOKENS[2], SELLER)
    await listing(LISTINGS[0], TOKENS[0], SELLER, 'CANCELLED', ME)
    await listing(LISTINGS[1], TOKENS[1], SELLER, 'ACTIVE', OTHER) // someone else's bid
    await listing(LISTINGS[2], TOKENS[2], SELLER, 'SOLD', ME)
    expect(ids(await findStaleListingCandidates(prisma, ME, 50))).to.deep.equal([LISTINGS[0]])
  })

  it('returns nothing for an address that owns no token and has no bid', async () => {
    await user(TOKENS[0], SELLER)
    await listing(LISTINGS[0], TOKENS[0], SELLER, 'CANCELLED')
    expect(await findStaleListingCandidates(prisma, OTHER, 50)).to.deep.equal([])
  })

  it('matches the address whatever its case', async () => {
    await user(TOKENS[0], '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa') // stored mixed case
    await listing(LISTINGS[0], TOKENS[0], SELLER, 'CANCELLED')
    expect(ids(await findStaleListingCandidates(prisma, ME.toUpperCase().replace('0X', '0x'), 50))).to.deep.equal([LISTINGS[0]])
  })

  it('lists the newest first and honours the limit', async () => {
    await user(TOKENS[0], ME)
    await listing(LISTINGS[0], TOKENS[0], SELLER, 'CANCELLED')
    await new Promise(r => setTimeout(r, 20))
    await listing(LISTINGS[1], TOKENS[0], SELLER, 'CANCELLED')
    const rows = await findStaleListingCandidates(prisma, ME, 1)
    expect(rows.map(r => r.listingId)).to.deep.equal([LISTINGS[1]])
  })
})
