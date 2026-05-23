-- Migration: stripe_purchases
-- Tracks card-funded profile purchases (Stripe Checkout).
-- All DDL uses IF NOT EXISTS per project convention.

CREATE TABLE IF NOT EXISTS "StripePurchase" (
    "id"               SERIAL       NOT NULL,
    "stripeSessionId"  TEXT         NOT NULL,
    "username"         TEXT         NOT NULL,
    "walletAddress"    TEXT         NOT NULL,
    "amountUsdCents"   INTEGER      NOT NULL,
    "depositAmountCaw" TEXT         NOT NULL,
    "networkId"        INTEGER      NOT NULL,
    "txHash"           TEXT,
    "status"           TEXT         NOT NULL DEFAULT 'pending',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mintedAt"         TIMESTAMP(3),

    CONSTRAINT "StripePurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StripePurchase_stripeSessionId_key"
    ON "StripePurchase"("stripeSessionId");

CREATE INDEX IF NOT EXISTS "StripePurchase_walletAddress_idx"
    ON "StripePurchase"("walletAddress");

CREATE INDEX IF NOT EXISTS "StripePurchase_status_idx"
    ON "StripePurchase"("status");
