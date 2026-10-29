import type { PrismaClient } from '@prisma/client'

/**
 * Record one BidPlaced event. Returns true when the bid row is new.
 *
 * The indexer re-scans the whole block range whenever a poll fails, so this
 * must be safe to run again on a bid it has already stored. Only a new bid
 * demotes the currently ACTIVE bids: on a replay, the stored ACTIVE bid is
 * the highest one, and demoting it would leave the listing with no ACTIVE
 * bid (the auction's winning bid would then never be marked WON, and the
 * leader would show up in the refunds list).
 */
export async function recordBid(
  db: Pick<PrismaClient, 'marketplaceBid'>,
  bid: { listingRowId: number; bidder: string; amount: string; txHash: string },
): Promise<boolean> {
  const { listingRowId, bidder, amount, txHash } = bid
  const where = { listingId_bidder_txHash: { listingId: listingRowId, bidder, txHash } }

  const before = await db.marketplaceBid.findUnique({ where, select: { id: true } })
  const wasNew = !before

  if (wasNew) {
    // Mark previous highest bid as outbid
    await db.marketplaceBid.updateMany({
      where: { listingId: listingRowId, status: 'ACTIVE' },
      data: { status: 'OUTBID' },
    })
  }

  // @@unique([listingId, bidder, txHash]) makes this an upsert: a retry hits
  // the no-op `update` branch instead of duplicating the row.
  await db.marketplaceBid.upsert({
    where,
    update: {},
    create: { listingId: listingRowId, bidder, amount, txHash, status: 'ACTIVE' },
  })

  return wasNew
}
