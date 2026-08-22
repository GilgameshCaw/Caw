-- Backfill migration: `WalletBlob` was added to schema.prisma in commit
-- f58d24ad ("feat(recovery): server-stored encrypted backup blob +
-- Resend email backstop (#217)", 2026-06-12) but no migration file was
-- generated for it — the commit message says explicitly "WalletBlob
-- model rides the next deploy via prisma db push", so the table only
-- ever existed via an ad hoc `db push` against the dev DB. Later dated
-- migrations (20260706000000_wallet_blob_prf,
-- 20260708010000_wallet_blob_session_prf) ALTER "WalletBlob" directly,
-- so a from-scratch replay fails with 42P01 without this migration
-- filling the gap. Shape matches what schema.prisma declared for this
-- table at this point in history (before the prfBlob / sessionPrfBlob
-- columns added by the two later migrations above) — this is not a new
-- schema change, just recording history that was skipped.

-- CreateTable
CREATE TABLE IF NOT EXISTS "WalletBlob" (
    "address" TEXT NOT NULL,
    "blob" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletBlob_pkey" PRIMARY KEY ("address")
);
