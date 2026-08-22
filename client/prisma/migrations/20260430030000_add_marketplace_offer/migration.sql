-- Backfill migration: `MarketplaceOffer` (+ `OfferStatus` enum) and
-- `Notification.offerId` were added to schema.prisma in commit 1b8497db
-- ("feat: track pending deposit amount and use it for stake checks",
-- 2026-04-20) but no migration file was generated for them at the time —
-- the table/column were only ever created ad hoc against the dev DB via
-- `db push`. Later dated migrations assume this shape already exists
-- (20260501010000_add_marketplace_offer_dismissal FKs to
-- "MarketplaceOffer"; 20260516200000_notification_groups reads
-- "Notification"."offerId" directly), so a from-scratch replay fails
-- with 42P01 / 42703 without this migration filling the gap. All
-- objects created here are exactly what schema.prisma has always
-- declared — this is not a new schema change, just recording history
-- that was skipped.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OfferStatus') THEN
    CREATE TYPE "OfferStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "MarketplaceOffer" (
    "id" SERIAL NOT NULL,
    "offerId" INTEGER NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "offerer" TEXT NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "paymentAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "username" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceOffer_offerId_key" ON "MarketplaceOffer"("offerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketplaceOffer_tokenId_status_idx" ON "MarketplaceOffer"("tokenId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketplaceOffer_offerer_status_idx" ON "MarketplaceOffer"("offerer", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketplaceOffer_status_createdAt_idx" ON "MarketplaceOffer"("status", "createdAt");

-- Add the back-reference column to Notification (nullable — only
-- populated for type=OFFER notifications).
ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "offerId" INTEGER;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Notification_offerId_fkey'
  ) THEN
    ALTER TABLE "Notification"
      ADD CONSTRAINT "Notification_offerId_fkey"
      FOREIGN KEY ("offerId") REFERENCES "MarketplaceOffer"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterEnum: NotificationType gained OFFER in the same schema.prisma
-- commit. ADD VALUE IF NOT EXISTS is safe outside a transaction block
-- for pg_prisma's per-statement execution.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OFFER';
