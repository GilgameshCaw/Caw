-- Sponsor Repay (Phase 2) — on-chain repay obligation tracking.
--
-- New SponsorRepay table mirrors L2 CawProfileLedger.sponsorRepay state.
-- Populated exclusively by the indexer:
--   ChainSyncService (L1 SponsorRepaySet on CawProfileMinter)
--   SponsorRepayIndexer (L2 Registered / Swept / Forgiven on CawProfileLedger)
-- API request handlers NEVER write to it.
--
-- Two new columns on SponsorCode drive the repay obligation amount applied
-- at /api/sponsor/bootstrap time:
--   repayBps         — basis points relative to deposit (10000 = 1x repay)
--   requireKycLevel  — KYC level required at withdraw (0 = none)
-- Both columns default 0 so existing rows continue to function unchanged.
--
-- All DDL uses IF NOT EXISTS per feedback_migration_if_not_exists.md.
-- Apply with: npx prisma db execute --file <this file>
-- DO NOT run prisma migrate dev (shadow DB is drifted).

-- ===========================================================================
-- SponsorCode: add repayBps + requireKycLevel
-- ===========================================================================

ALTER TABLE "SponsorCode"
  ADD COLUMN IF NOT EXISTS "repayBps" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SponsorCode"
  ADD COLUMN IF NOT EXISTS "requireKycLevel" INTEGER NOT NULL DEFAULT 0;

-- ===========================================================================
-- SponsorRepay
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "SponsorRepay" (
  "tokenId"                INTEGER     NOT NULL,
  "sponsorTokenId"         INTEGER     NOT NULL,
  "originalRepayAmount"    TEXT        NOT NULL,
  "currentRepayAmount"     TEXT        NOT NULL,
  "sponsoredDepositAmount" TEXT,
  "registeredAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "forgivenAt"             TIMESTAMPTZ,
  "lastSweepAmount"        TEXT,
  "lastSweepAt"            TIMESTAMPTZ,
  "txHashSet"              TEXT,
  "txHashRegistered"       TEXT,
  CONSTRAINT "SponsorRepay_pkey" PRIMARY KEY ("tokenId")
);

CREATE INDEX IF NOT EXISTS "SponsorRepay_sponsorTokenId_idx"
  ON "SponsorRepay" ("sponsorTokenId");
