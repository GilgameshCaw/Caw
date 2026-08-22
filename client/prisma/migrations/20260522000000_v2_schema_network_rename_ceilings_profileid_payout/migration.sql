-- V2 schema migration: Client → Network rename, per-fee ceilings, session
-- profileId, and MarketplacePayout tracking.
--
-- This is a CLEAN-BREAK migration targeting a fresh caw_v2_local database.
-- The V1 database (caw_local / caw_dev) is untouched.
--
-- Three independent areas:
--   A. Rename "Client" table → "Network"; rename clientId → networkId across
--      ClientAuth → NetworkAuth, ReplicationTx, StakeLedgerState.
--   B. Add per-fee ceiling columns to the new Network table.
--   C. Add profileId column + index to SessionKey.
--   D. Add MarketplacePayout table.
--
-- All DDL uses IF NOT EXISTS per feedback_migration_if_not_exists.md.
-- Apply with: npx prisma db execute --file <this file>

-- ===========================================================================
-- A. Rename Client → Network
-- ===========================================================================

-- The Prisma shadow DB is drifted (no migrate dev); we use hand-rolled SQL.
--
-- Historically this block was commented out because the fresh-DB
-- bootstrap path was `prisma db push` (which creates "Network" /
-- "NetworkAuth" directly from schema.prisma, making these renames
-- no-ops that would error against a table that doesn't exist). Now that
-- `00000000000000_init` and the SessionKey/ClientAuth backfill migration
-- (20260505120000) create "Client" / "ClientAuth" / "ReplicationTx"."clientId"
-- / "StakeLedgerState"."clientId" under their original V1 names, a
-- `prisma migrate deploy` replay needs these renames to actually run so
-- the resulting shape matches schema.prisma's Network / NetworkAuth /
-- networkId. Each statement is guarded with IF EXISTS so it stays a
-- no-op if ever re-run against a DB where the rename already happened
-- (e.g. a `db push`-bootstrapped install upgrading to migrations).

-- Rename the primary table:
ALTER TABLE IF EXISTS "Client" RENAME TO "Network";

-- Rename ClientAuth → NetworkAuth:
ALTER TABLE IF EXISTS "ClientAuth" RENAME TO "NetworkAuth";

-- Rename clientId column in NetworkAuth:
ALTER TABLE IF EXISTS "NetworkAuth" RENAME COLUMN "clientId" TO "networkId";

-- Rename the unique constraint on NetworkAuth:
ALTER INDEX IF EXISTS "ClientAuth_clientId_tokenId_key" RENAME TO "NetworkAuth_networkId_tokenId_key";

-- Rename clientId column in ReplicationTx:
ALTER TABLE IF EXISTS "ReplicationTx" RENAME COLUMN "clientId" TO "networkId";

-- Update the index on ReplicationTx:
DROP INDEX IF EXISTS "ReplicationTx_clientId_createdAt_idx";
CREATE INDEX IF NOT EXISTS "ReplicationTx_networkId_createdAt_idx" ON "ReplicationTx" ("networkId", "createdAt");

-- Rename clientId column in StakeLedgerState:
ALTER TABLE IF EXISTS "StakeLedgerState" RENAME COLUMN "clientId" TO "networkId";

-- ===========================================================================
-- B. Per-fee ceiling columns on Network
-- ===========================================================================

-- On a fresh V2 DB these columns are created by prisma db push; this is the
-- upgrade path for an existing V1 "Client" table (already renamed above).
ALTER TABLE IF EXISTS "Network"
  ADD COLUMN IF NOT EXISTS "withdrawFeeCeiling" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "depositFeeCeiling"  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "authFeeCeiling"      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mintFeeCeiling"      BIGINT NOT NULL DEFAULT 0;

-- ===========================================================================
-- C. profileId on SessionKey
-- ===========================================================================

ALTER TABLE IF EXISTS "SessionKey"
  ADD COLUMN IF NOT EXISTS "profileId" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "SessionKey_profileId_idx"
  ON "SessionKey" ("profileId");

-- ===========================================================================
-- D. MarketplacePayout table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "MarketplacePayout" (
  "id"              SERIAL PRIMARY KEY,
  "seller"          TEXT NOT NULL,
  "amount"          BIGINT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "queuedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "queuedTxHash"    TEXT NOT NULL,
  "withdrawnAt"     TIMESTAMP(3),
  "withdrawnTxHash" TEXT,
  "recipient"       TEXT
);

CREATE INDEX IF NOT EXISTS "MarketplacePayout_seller_status_idx"
  ON "MarketplacePayout" ("seller", "status");

CREATE INDEX IF NOT EXISTS "MarketplacePayout_status_idx"
  ON "MarketplacePayout" ("status");

CREATE INDEX IF NOT EXISTS "MarketplacePayout_queuedTxHash_idx"
  ON "MarketplacePayout" ("queuedTxHash");
