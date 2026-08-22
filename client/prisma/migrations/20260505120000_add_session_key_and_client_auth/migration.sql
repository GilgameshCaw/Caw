-- Backfill migration: `SessionKey` and `ClientAuth` were added to
-- schema.prisma in commit fbc851c8 ("feat: add SessionKey and ClientAuth
-- models for indexed on-chain state", 2026-04-14) but no migration file
-- was generated for them — the tables were only ever created ad hoc
-- against the dev DB via `db push`. A later dated migration
-- (20260506200000_session_per_action_tip_rate) ALTERs "SessionKey"
-- directly, so a from-scratch replay fails with 42P01 without this
-- migration filling the gap. Shape matches what schema.prisma has
-- always declared for these two tables at this point in history (before
-- the later V2 rename to NetworkAuth / clientId->networkId, and before
-- the profileId column added in 20260522000000) — this is not a new
-- schema change, just recording history that was skipped.

-- CreateTable
CREATE TABLE IF NOT EXISTS "SessionKey" (
    "id" SERIAL NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "sessionAddress" TEXT NOT NULL,
    "expiry" BIGINT NOT NULL,
    "scopeBitmap" INTEGER NOT NULL,
    "spendLimit" TEXT NOT NULL,
    "spent" TEXT NOT NULL DEFAULT '0',
    "revokedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SessionKey_ownerAddress_sessionAddress_key" ON "SessionKey"("ownerAddress", "sessionAddress");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SessionKey_ownerAddress_idx" ON "SessionKey"("ownerAddress");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SessionKey_sessionAddress_idx" ON "SessionKey"("sessionAddress");

-- CreateTable
-- Named "ClientAuth" here (matching the original commit + the
-- 20260522 rename migration's commented-out `RENAME TO "NetworkAuth"`
-- reference); that later migration renames it when it un-comments its
-- Client->Network rename block.
CREATE TABLE IF NOT EXISTS "ClientAuth" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "authenticated" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientAuth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ClientAuth_clientId_tokenId_key" ON "ClientAuth"("clientId", "tokenId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ClientAuth_tokenId_idx" ON "ClientAuth"("tokenId");
