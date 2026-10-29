// recordBid is called once per BidPlaced log, and the indexer re-scans the
// whole range when a poll fails, so the same log is seen more than once. The
// stub below implements only the three marketplaceBid calls recordBid makes;
// recordBid itself is the real module.

import { expect } from 'chai'
import { recordBid } from '../../../src/services/MarketplaceIndexerService/recordBid'

type Row = { id: number; listingId: number; bidder: string; amount: string; txHash: string; status: string }

function makeDb() {
  const rows: Row[] = []
  const key = (w: any) => w.listingId_bidder_txHash
  const find = (k: any) => rows.find(r => r.listingId === k.listingId && r.bidder === k.bidder && r.txHash === k.txHash)
  const db: any = {
    marketplaceBid: {
      findUnique: async ({ where }: any) => {
        const r = find(key(where))
        return r ? { id: r.id } : null
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const r of rows) {
          if (r.listingId === where.listingId && r.status === where.status) { r.status = data.status; count++ }
        }
        return { count }
      },
      upsert: async ({ where, update, create }: any) => {
        const r = find(key(where))
        if (r) return Object.assign(r, update)
        const row = { id: rows.length + 1, ...create }
        rows.push(row)
        return row
      },
    },
  }
  return { db, rows }
}

const bid = (listingRowId: number, bidder: string, n: number) => ({
  listingRowId, bidder, amount: String(n * 100), txHash: `0xtx${n}`,
})
const statuses = (rows: Row[]) => rows.map(r => `${r.txHash}:${r.status}`)

describe('MarketplaceIndexer / recordBid', () => {
  it('a new bid is ACTIVE and demotes the previous ACTIVE bid', async () => {
    const { db, rows } = makeDb()
    expect(await recordBid(db, bid(1, '0xa', 1))).to.equal(true)
    expect(await recordBid(db, bid(1, '0xb', 2))).to.equal(true)
    expect(statuses(rows)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('replaying the same range leaves the highest bid ACTIVE and adds no rows', async () => {
    const { db, rows } = makeDb()
    await recordBid(db, bid(1, '0xa', 1))
    await recordBid(db, bid(1, '0xb', 2))
    expect(await recordBid(db, bid(1, '0xa', 1))).to.equal(false)
    expect(await recordBid(db, bid(1, '0xb', 2))).to.equal(false)
    expect(statuses(rows)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('replaying a single stored bid keeps it ACTIVE', async () => {
    const { db, rows } = makeDb()
    await recordBid(db, bid(1, '0xa', 1))
    expect(await recordBid(db, bid(1, '0xa', 1))).to.equal(false)
    expect(statuses(rows)).to.deep.equal(['0xtx1:ACTIVE'])
  })

  it('a replay that reaches a bid not stored yet demotes the stored one', async () => {
    const { db, rows } = makeDb()
    await recordBid(db, bid(1, '0xa', 1))
    expect(await recordBid(db, bid(1, '0xa', 1))).to.equal(false)
    expect(await recordBid(db, bid(1, '0xb', 2))).to.equal(true)
    expect(statuses(rows)).to.deep.equal(['0xtx1:OUTBID', '0xtx2:ACTIVE'])
  })

  it('does not touch the bids of another listing', async () => {
    const { db, rows } = makeDb()
    await recordBid(db, bid(1, '0xa', 1))
    await recordBid(db, bid(2, '0xb', 2))
    expect(statuses(rows)).to.deep.equal(['0xtx1:ACTIVE', '0xtx2:ACTIVE'])
  })
})
