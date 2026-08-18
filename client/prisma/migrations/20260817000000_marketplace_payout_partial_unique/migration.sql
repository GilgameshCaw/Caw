-- Fix: MarketplaceIndexerService creates a MarketplacePayout row per PayoutQueued
-- event. queuedTxHash alone is NOT unique (one tx can queue multiple sellers), so
-- block resync/replay duplicated pending payout rows; the catch only logged and
-- continued. e24c207 adds queuedLogIndex (ethers v6 ev.index) and treats a P2002
-- on replay as an idempotent no-op -- but that dedup only works if the matching
-- partial UNIQUE index exists. Prisma @@unique cannot express a partial
-- (WHERE ... IS NOT NULL) index, so it is created here in raw SQL.
--
-- queuedLogIndex is nullable: pre-existing rows stay NULL and are excluded from
-- the partial index (no backfill, no collision). prod caw_v2 MarketplacePayout
-- was verified at 0 rows, so no existing-duplicate merge step is needed.
--
-- The index name and predicate MUST stay in sync with the runtime P2002 path in
-- MarketplaceIndexerService/index.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplacePayout_queuedTxHash_queuedLogIndex_key"
  ON "MarketplacePayout" ("queuedTxHash", "queuedLogIndex")
  WHERE "queuedLogIndex" IS NOT NULL;
