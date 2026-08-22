-- Backfill migration: repairs residual schema drift between the replayed
-- migration history and schema.prisma (see `prisma migrate diff` output,
-- generated via `migrate diff --from-migrations --to-schema-datamodel`).
--
-- This is the "everything except enum ADD VALUE" half of the drift (the
-- enum values live in 20260823000000_backfill_enum_values, which must run
-- first since Postgres can't ADD VALUE inside the same transaction as other
-- DDL). Statements are made idempotent (IF EXISTS / IF NOT EXISTS) so this
-- migration is safe to re-run or to apply on a DB that already has some of
-- these objects from a prior partial apply. FK drop+readd pairs are kept
-- as pairs (not "optimized" away) since they encode onDelete behavior
-- changes from what the original migration chain produced.

-- ============================================================
-- DropForeignKey (paired with AddForeignKey below; onDelete changes)
-- ============================================================
ALTER TABLE "public"."GroupInvite" DROP CONSTRAINT IF EXISTS "GroupInvite_createdByUserId_fkey";
ALTER TABLE "public"."MarketplaceOfferDismissal" DROP CONSTRAINT IF EXISTS "MarketplaceOfferDismissal_offerId_fkey";
ALTER TABLE "public"."MarketplaceOfferDismissal" DROP CONSTRAINT IF EXISTS "MarketplaceOfferDismissal_userId_fkey";
ALTER TABLE "public"."MessageReaction" DROP CONSTRAINT IF EXISTS "MessageReaction_userId_fkey";
ALTER TABLE "public"."Notification" DROP CONSTRAINT IF EXISTS "Notification_groupId_fkey";
ALTER TABLE "public"."NotificationGroup" DROP CONSTRAINT IF EXISTS "NotificationGroup_userId_fkey";
ALTER TABLE "public"."OnChainImage" DROP CONSTRAINT IF EXISTS "OnChainImage_userId_fkey";
ALTER TABLE "public"."Vote" DROP CONSTRAINT IF EXISTS "Vote_voterId_fkey";

-- ============================================================
-- DropIndex (superseded by CreateIndex below, or removed outright)
-- ============================================================
DROP INDEX IF EXISTS "public"."NotificationGroup_userId_lastEventAt_idx";
DROP INDEX IF EXISTS "public"."TxQueue_signedTx_key";

-- ============================================================
-- AlterTable: column type widenings (DATE -> TIMESTAMP(3))
-- ============================================================
ALTER TABLE "CawOwnershipCurrent" ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "CawOwnershipSnapshot" ALTER COLUMN "blockTimestamp" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "ModeratorAction" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "RewardMultiplierSnapshot" ALTER COLUMN "blockTimestamp" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "StakeLedgerState" ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- ============================================================
-- AlterTable: Network (drop legacy replication columns, add creationBlock)
-- ============================================================
ALTER TABLE "Network" DROP COLUMN IF EXISTS "replicationCount",
DROP COLUMN IF EXISTS "replicationEnabled",
DROP COLUMN IF EXISTS "replications",
ADD COLUMN IF NOT EXISTS "creationBlock" BIGINT;

-- ============================================================
-- AlterTable: Notification (add actionPayload snapshot for ACTION_FAILED etc.)
-- ============================================================
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "actionPayload" JSONB;

-- ============================================================
-- AlterTable: ReplicationTx (rename destEid/lzFee era columns to
-- submitter/endCheckpointId era columns)
-- ============================================================
ALTER TABLE "ReplicationTx" DROP COLUMN IF EXISTS "destEid",
DROP COLUMN IF EXISTS "lzFee",
ADD COLUMN IF NOT EXISTS "endCheckpointId" INTEGER,
ADD COLUMN IF NOT EXISTS "submitter" TEXT;

-- ============================================================
-- AlterTable: ScheduledCaw (thread scheduling fields)
-- ============================================================
ALTER TABLE "ScheduledCaw" ADD COLUMN IF NOT EXISTS "threadId" TEXT,
ADD COLUMN IF NOT EXISTS "threadIndex" INTEGER,
ADD COLUMN IF NOT EXISTS "threadTotal" INTEGER;

-- ============================================================
-- AlterTable: TxQueue (batching + pending deposit tracking)
-- ============================================================
ALTER TABLE "TxQueue" ADD COLUMN IF NOT EXISTS "batchId" INTEGER,
ADD COLUMN IF NOT EXISTS "pendingDepositTxHash" TEXT;

-- ============================================================
-- AlterTable: User (rename likeCount -> likedCount/likesReceivedCount split,
-- add profile/deposit/recaw bookkeeping columns)
-- ============================================================
ALTER TABLE "User" DROP COLUMN IF EXISTS "likeCount",
ADD COLUMN IF NOT EXISTS "defaultAvatarId" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lastViewedOffersAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "likedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "likesReceivedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "pendingDepositAmount" TEXT,
ADD COLUMN IF NOT EXISTS "profileSource" TEXT NOT NULL DEFAULT 'onchain',
ADD COLUMN IF NOT EXISTS "recawCount" INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- DropTable: OnChainImage (superseded; removed from schema.prisma)
-- ============================================================
DROP TABLE IF EXISTS "public"."OnChainImage";

-- ============================================================
-- CreateTable: ChallengeLock (archive-challenge coordination lock; see
-- project_replication_wire_format.md / CawActionsArchive challenge flow)
-- ============================================================
CREATE TABLE IF NOT EXISTS "ChallengeLock" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "submissionId" BIGINT NOT NULL,
    "checkpointId" BIGINT NOT NULL,
    "holder" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT,
    "txHash" TEXT,

    CONSTRAINT "ChallengeLock_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "ChallengeLock_kind_submissionId_idx" ON "ChallengeLock"("kind", "submissionId");

CREATE INDEX IF NOT EXISTS "ChallengeLock_expiresAt_idx" ON "ChallengeLock"("expiresAt");

-- ============================================================
-- CreateIndex: assorted missing indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS "Action_senderId_idx" ON "Action"("senderId");

CREATE INDEX IF NOT EXISTS "Action_actionType_createdAt_idx" ON "Action"("actionType", "createdAt");

CREATE INDEX IF NOT EXISTS "Caw_status_createdAt_idx" ON "Caw"("status", "createdAt");

-- NOTE: 20260506100000_dm_relay_dedup_and_request_inbox already created an
-- index with this exact name, but as a PARTIAL unique index
-- (`WHERE "relayId" IS NOT NULL`). schema.prisma's plain `@unique` on this
-- nullable column expects a full (non-partial) unique index, so the old
-- partial one has to be dropped and replaced under the same name — a bare
-- `IF NOT EXISTS` here would be a no-op against the pre-existing partial
-- index and leave the drift unresolved.
DROP INDEX IF EXISTS "Message_relayId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Message_relayId_key" ON "Message"("relayId");

CREATE INDEX IF NOT EXISTS "NotificationGroup_userId_lastEventAt_idx" ON "NotificationGroup"("userId", "lastEventAt");

CREATE INDEX IF NOT EXISTS "ReplicationTx_submitter_createdAt_idx" ON "ReplicationTx"("submitter", "createdAt");

CREATE INDEX IF NOT EXISTS "ScheduledCaw_threadId_threadIndex_idx" ON "ScheduledCaw"("threadId", "threadIndex");

CREATE INDEX IF NOT EXISTS "TxQueue_batchId_idx" ON "TxQueue"("batchId");

CREATE INDEX IF NOT EXISTS "TxQueue_signedTx_idx" ON "TxQueue"("signedTx");

CREATE INDEX IF NOT EXISTS "User_cawCount_followerCount_idx" ON "User"("cawCount", "followerCount");

-- ============================================================
-- AddForeignKey (re-add with onDelete matching schema.prisma)
-- ============================================================
DO $$ BEGIN
  ALTER TABLE "Vote" ADD CONSTRAINT "Vote_voterId_fkey" FOREIGN KEY ("voterId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "NotificationGroup" ADD CONSTRAINT "NotificationGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Notification" ADD CONSTRAINT "Notification_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NotificationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "GroupInvite" ADD CONSTRAINT "GroupInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "DmIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DmIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MarketplaceOfferDismissal" ADD CONSTRAINT "MarketplaceOfferDismissal_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "MarketplaceOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MarketplaceOfferDismissal" ADD CONSTRAINT "MarketplaceOfferDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
