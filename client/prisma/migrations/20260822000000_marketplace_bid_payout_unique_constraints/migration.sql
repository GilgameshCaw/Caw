-- Fix: MarketplaceIndexerService (commit 9b32f5ab, "hold checkpoint when
-- PayoutWithdrawn fails to record") re-scans the WHOLE poll block range
-- (up to 2000 blocks, uncapped) on ANY handler failure in that range —
-- including failures unrelated to bids/payouts. Two handlers in that file
-- were plain `.create()` calls with no unique constraint to dedupe against:
--
--   BidPlaced   -> prisma.marketplaceBid.create(...)     (no unique constraint at all)
--   PayoutQueued -> prisma.marketplacePayout.create(...)  (comment admitted no
--                   unique constraint on queuedTxHash; duplicate rows directly
--                   inflate a seller's pending-payout total in the UI)
--
-- Every retry of a held-checkpoint range re-emitted a fresh duplicate row
-- for every BidPlaced/PayoutQueued log in that range, for as long as the
-- unrelated failure persisted. This migration adds the missing unique
-- constraints (matching the columns the handlers actually populate) so the
-- application-side .create() -> .upsert() change (MarketplaceIndexerService/
-- index.ts) makes a retry a no-op instead of a duplicate insert.
--
-- MarketplaceBid has no logIndex column, only txHash — so event identity is
-- approximated as (listingId, bidder, txHash). One bidder can't place two
-- BidPlaced logs for the same listing in the same tx (the contract call
-- either reverts or emits one event), so this triple is safe as the natural
-- key for a single on-chain bid.
--
-- MarketplacePayout's own handler comment already establishes queuedTxHash
-- alone is not unique (one tx can queue payouts for multiple sellers), but
-- (queuedTxHash, seller) is — a given seller appears once per PayoutQueued
-- log per tx.
--
-- Both indexes are UNIQUE, so any pre-existing duplicate rows (already
-- produced by the bug this migration fixes) must be merged/deleted first,
-- or CREATE UNIQUE INDEX fails outright.

-- 1) Dedupe existing MarketplaceBid rows that collide on
--    (listingId, bidder, txHash). Keep the lowest id (first-written) row per
--    bucket, delete the rest. NULL txHash rows are left alone — Postgres
--    treats NULLs as distinct for uniqueness purposes, so they can never
--    violate the new constraint and don't need dedup here.
DELETE FROM "MarketplaceBid" b
USING "MarketplaceBid" b2
WHERE b."txHash" IS NOT NULL
  AND b2."txHash" IS NOT NULL
  AND b."listingId" = b2."listingId"
  AND b."bidder" = b2."bidder"
  AND b."txHash" = b2."txHash"
  AND b.id > b2.id;

-- 2) Dedupe existing MarketplacePayout rows that collide on
--    (queuedTxHash, seller). Keep the lowest id (first-written) row per
--    bucket, delete the rest. queuedTxHash is NOT NULL on this model, so
--    every row participates in the dedup check.
DELETE FROM "MarketplacePayout" p
USING "MarketplacePayout" p2
WHERE p."queuedTxHash" = p2."queuedTxHash"
  AND p."seller" = p2."seller"
  AND p.id > p2.id;

-- 3) Create the unique constraints (IF NOT EXISTS: safe to re-run / safe if
--    a prior partial apply already created one of them).
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceBid_listingId_bidder_txHash_key"
  ON "MarketplaceBid" ("listingId", "bidder", "txHash");

CREATE UNIQUE INDEX IF NOT EXISTS "MarketplacePayout_queuedTxHash_seller_key"
  ON "MarketplacePayout" ("queuedTxHash", "seller");
