import type { PrismaClient } from '@prisma/client'

/**
 * The offers an address made that the indexer has marked EXPIRED, most
 * recently expired first. On chain such an offer is still active, with its
 * funds escrowed, until cancelOffer is called (anyone can call it after
 * expiry; the refund goes to the offerer). Candidates only: an offer refunded
 * before OfferCancelled could move it on may still be listed, so the
 * frontend confirms on chain (offers(id).active) before showing it.
 */
export async function findReclaimableOffers(
  db: Pick<PrismaClient, 'marketplaceOffer'>,
  address: string,
  limit: number,
  offset: number,
) {
  const where = { offerer: address.toLowerCase(), status: 'EXPIRED' as const }
  const [offers, total] = await Promise.all([
    db.marketplaceOffer.findMany({ where, orderBy: { expiry: 'desc' }, take: limit, skip: offset }),
    db.marketplaceOffer.count({ where }),
  ])
  return { offers, total, hasMore: offset + offers.length < total }
}
