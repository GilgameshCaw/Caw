-- Per-recipient dismissal of marketplace offers. The on-chain offer status
-- (ACTIVE/ACCEPTED/CANCELLED/EXPIRED) is mirrored by MarketplaceIndexer from
-- chain events and gets re-asserted on every block-rewind window — so we
-- can't use that column for "the recipient hid this from their view." Store
-- dismissal as a separate per-(offer, user) row instead. One row per pair so
-- each token owner can independently dismiss; the unique constraint makes the
-- dismiss endpoint idempotent.
--
-- Hand-rolled to match the pattern used by other migrations in this repo (the
-- shadow DB is drifted from migration history).

CREATE TABLE IF NOT EXISTS "MarketplaceOfferDismissal" (
  "id"        SERIAL PRIMARY KEY,
  "offerId"   INTEGER NOT NULL,
  "userId"    INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceOfferDismissal_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "MarketplaceOffer"("id") ON DELETE CASCADE,
  CONSTRAINT "MarketplaceOfferDismissal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceOfferDismissal_offerId_userId_key"
  ON "MarketplaceOfferDismissal" ("offerId", "userId");

CREATE INDEX IF NOT EXISTS "MarketplaceOfferDismissal_userId_idx"
  ON "MarketplaceOfferDismissal" ("userId");
