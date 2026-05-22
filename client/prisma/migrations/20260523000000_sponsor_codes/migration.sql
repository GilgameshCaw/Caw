-- Sponsor invite-code gating for /api/sponsor/bootstrap.
-- Two-tier system: short pretty codes (Tier 1) and long random codes (Tier 2).
-- The raw code is never stored; only HMAC-SHA256(secret, normalizedCode).
--
-- All DDL uses IF NOT EXISTS per feedback_migration_if_not_exists.md.
-- Apply with: npx prisma db execute --file <this file>
-- DO NOT run prisma migrate dev (shadow DB is drifted).

-- ===========================================================================
-- SponsorCode
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "SponsorCode" (
  "codeHash"             TEXT        NOT NULL,
  "tier"                 TEXT        NOT NULL,
  "label"                TEXT,
  "budgetCapUsdCents"    INTEGER     NOT NULL,
  "maxDepositCawWei"     TEXT        NOT NULL,
  "maxUses"              INTEGER,
  "usesRemaining"        INTEGER,
  "minUsernameLength"    INTEGER     NOT NULL DEFAULT 0,
  "networkOwnerAddress"  TEXT,
  "expiresAt"            TIMESTAMPTZ NOT NULL,
  "createdBy"            TEXT,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SponsorCode_pkey" PRIMARY KEY ("codeHash")
);

-- ===========================================================================
-- SponsorRedemption
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "SponsorRedemption" (
  "id"               SERIAL      NOT NULL,
  "codeHash"         TEXT        NOT NULL,
  "recipient"        TEXT        NOT NULL,
  "txHash"           TEXT,
  "gasCostUsdCents"  INTEGER     NOT NULL,
  "netFeesUsdCents"  INTEGER     NOT NULL,
  "lzFeeUsdCents"    INTEGER     NOT NULL,
  "depositUsdCents"  INTEGER     NOT NULL,
  "totalUsdCents"    INTEGER     NOT NULL,
  "redeemedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SponsorRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SponsorRedemption_codeHash_fkey"
    FOREIGN KEY ("codeHash") REFERENCES "SponsorCode"("codeHash")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SponsorRedemption_codeHash_idx"
  ON "SponsorRedemption"("codeHash");

CREATE INDEX IF NOT EXISTS "SponsorRedemption_recipient_idx"
  ON "SponsorRedemption"("recipient");

CREATE INDEX IF NOT EXISTS "SponsorRedemption_redeemedAt_idx"
  ON "SponsorRedemption"("redeemedAt");

-- ===========================================================================
-- SponsorCodeAttempt
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "SponsorCodeAttempt" (
  "id"          SERIAL      NOT NULL,
  "ip"          TEXT        NOT NULL,
  "attemptedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SponsorCodeAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SponsorCodeAttempt_ip_attemptedAt_idx"
  ON "SponsorCodeAttempt"("ip", "attemptedAt");
