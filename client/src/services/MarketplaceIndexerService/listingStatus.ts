import type { PrismaClient } from '@prisma/client'

/**
 * Apply a ListingCancelled event to the listing's row.
 *
 * The indexer sets EXPIRED from its own clock for an English auction that
 * ended without bids, but on chain that listing is still active, and its
 * token stays locked ("Token already listed"), until the seller calls
 * cancelListing. So the event can still arrive for an EXPIRED row and must
 * move it on; otherwise a cancelled listing stays EXPIRED for good and can't
 * be told apart from one that still locks its token. SOLD and CANCELLED are
 * final.
 */
export function markListingCancelled(db: Pick<PrismaClient, 'marketplaceListing'>, listingId: number) {
  return db.marketplaceListing.updateMany({
    where: { listingId, status: { in: ['ACTIVE', 'EXPIRED'] } },
    data: { status: 'CANCELLED' },
  })
}
