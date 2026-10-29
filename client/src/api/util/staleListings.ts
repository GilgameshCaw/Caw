import type { PrismaClient } from '@prisma/client'

/**
 * Listings an address may need to clear, because the token moved away from the
 * listing's seller while the listing was still open.
 *
 * The marketplace does not escrow the NFT, only holds an approval, so a seller
 * can transfer a listed token away. On chain the listing then stays active and
 * keeps the token locked ("Token already listed" on createListing) until
 * someone calls reclaimListing (no bids) or reclaimBid (an English auction
 * with a bid, which also frees the highest bidder's funds). The indexer marks
 * such a listing CANCELLED, so no list shows it.
 *
 * Two roles can need it: the token's current owner (cannot list the token) and
 * the highest bidder (the bid is held). Candidates only, other people's live
 * listings included for a bidder: the frontend asks the chain which of them
 * are really stale.
 */
export async function findStaleListingCandidates(
  db: Pick<PrismaClient, 'user' | 'marketplaceListing'>,
  address: string,
  limit: number,
) {
  const addr = address.toLowerCase()
  const owned = await db.user.findMany({
    where: { address: { equals: addr, mode: 'insensitive' } },
    select: { tokenId: true },
  })
  const tokenIds = owned.map(u => u.tokenId)
  return db.marketplaceListing.findMany({
    where: {
      status: { not: 'SOLD' },
      seller: { not: addr },
      OR: [
        ...(tokenIds.length ? [{ tokenId: { in: tokenIds } }] : []),
        { highestBidder: addr },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
