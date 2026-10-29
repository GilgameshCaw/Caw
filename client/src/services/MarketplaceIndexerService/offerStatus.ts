import type { PrismaClient } from '@prisma/client'

/**
 * Apply an OfferAccepted / OfferCancelled event to the offer's row.
 *
 * The indexer sets EXPIRED from its own clock once an offer's expiry has
 * passed, but on chain an expired offer is still active and its funds are
 * still escrowed until someone calls cancelOffer (anyone can, after expiry;
 * the refund goes to the offerer). So these two events can still arrive for
 * an EXPIRED row and must move it on, otherwise a refunded or accepted offer
 * stays EXPIRED for good and can't be told apart from one that is still
 * holding funds. ACCEPTED and CANCELLED are final.
 */
export function closeOffer(
  db: Pick<PrismaClient, 'marketplaceOffer'>,
  offerId: number,
  status: 'ACCEPTED' | 'CANCELLED',
) {
  return db.marketplaceOffer.updateMany({
    where: { offerId, status: { in: ['ACTIVE', 'EXPIRED'] } },
    data: { status },
  })
}
