-- Move X verification from per-User to per-Wallet. The OAuth flow proves
-- "this wallet controls this X account" so the link is a wallet-level
-- fact; every CAW profile owned by that wallet inherits it. Per-profile
-- show/hide stays on User.xBadgeVisible.
--
-- Hard cutover: the prior per-User columns are dropped (no production data
-- has been collected yet — the prior add_x_verification migration shipped
-- in dev only).

-- 1) Drop the per-User X columns + their unique index.
DROP INDEX IF EXISTS "User_xUserId_key";
ALTER TABLE "User" DROP COLUMN IF EXISTS "xHandle";
ALTER TABLE "User" DROP COLUMN IF EXISTS "xUserId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "xLinkedAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "xFollowerBucket";
ALTER TABLE "User" DROP COLUMN IF EXISTS "xFollowersUpdatedAt";

-- 2) Per-profile badge visibility. Default true so that the profile that
--    initiated the OAuth flow shows the badge by default; the FE flips
--    sibling profiles owned by the same wallet to false at link time.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "xBadgeVisible" BOOLEAN NOT NULL DEFAULT TRUE;

-- 3) New wallet-scoped link table. address is stored lowercased; the
--    application normalizes on every read/write so the unique constraint
--    behaves like a case-insensitive index.
CREATE TABLE IF NOT EXISTS "WalletXLink" (
    "id"                  SERIAL          PRIMARY KEY,
    "address"             TEXT            NOT NULL,
    "xUserId"             TEXT            NOT NULL,
    "xHandle"             TEXT            NOT NULL,
    "xFollowerBucket"     INTEGER,
    "linkedAt"            TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followersUpdatedAt"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "WalletXLink_address_key"
    ON "WalletXLink" ("address");
CREATE UNIQUE INDEX IF NOT EXISTS "WalletXLink_xUserId_key"
    ON "WalletXLink" ("xUserId");
CREATE INDEX IF NOT EXISTS "WalletXLink_xHandle_idx"
    ON "WalletXLink" ("xHandle");
