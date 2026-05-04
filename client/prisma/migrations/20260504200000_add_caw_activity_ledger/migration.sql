-- Ledger of per-user CAW balance changes, written by the StakeLedger
-- snapshotter. Mirrors CawProfileL2.cawOwnership state transitions
-- bit-for-bit using TypeScript bigint arithmetic; the snapshotter
-- audits itself via a per-event rewardMultiplier RPC checksum and a
-- daily per-active-user reconciliation cron.

-- One row per touched user per action (sender + recipient if any),
-- plus rows for L1->L2 deposits and withdrawals. Communal rewards are
-- NOT a row here — they are computed at query time from
-- RewardMultiplierSnapshot deltas joined against the user's most
-- recent CawOwnershipSnapshot.
CREATE TABLE IF NOT EXISTS "CawOwnershipSnapshot" (
  "id"                  BIGSERIAL PRIMARY KEY,
  "tokenId"             INTEGER NOT NULL,
  "blockNumber"         BIGINT NOT NULL,
  "blockTimestamp"      TIMESTAMP NOT NULL,
  "txHash"              TEXT NOT NULL,
  "logIndex"            INTEGER NOT NULL,
  "actionIndex"         INTEGER,
  "ownership"           TEXT NOT NULL,
  "multiplier"          TEXT NOT NULL,
  "balance"             TEXT NOT NULL,
  "delta"               TEXT NOT NULL,
  "reason"              TEXT NOT NULL,
  "actionType"          TEXT,
  "counterpartyTokenId" INTEGER,
  "createdAt"           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "CawOwnershipSnapshot_tokenId_blockTimestamp_idx"
  ON "CawOwnershipSnapshot"("tokenId", "blockTimestamp");

CREATE INDEX IF NOT EXISTS "CawOwnershipSnapshot_blockTimestamp_idx"
  ON "CawOwnershipSnapshot"("blockTimestamp");

-- One row per multiplier change. Drives communal-reward attribution:
-- a user's communal income across [t0, t1] = SUM over events e in
-- window: cawOwnership_at(user, e.timestamp) * (multiplierAfter -
-- multiplierBefore) / 1e18.
CREATE TABLE IF NOT EXISTS "RewardMultiplierSnapshot" (
  "blockNumber"      BIGINT NOT NULL,
  "txHash"           TEXT NOT NULL,
  "logIndex"         INTEGER NOT NULL,
  "actionIndex"      INTEGER NOT NULL,
  "blockTimestamp"   TIMESTAMP NOT NULL,
  "multiplierBefore" TEXT NOT NULL,
  "multiplierAfter"  TEXT NOT NULL,
  "communalAmount"   TEXT NOT NULL,
  PRIMARY KEY ("blockNumber", "logIndex", "actionIndex")
);

CREATE INDEX IF NOT EXISTS "RewardMultiplierSnapshot_blockTimestamp_idx"
  ON "RewardMultiplierSnapshot"("blockTimestamp");

-- Per-client running state of the StakeLedger snapshotter. Persisted
-- so a process restart can resume without replaying from genesis.
CREATE TABLE IF NOT EXISTS "StakeLedgerState" (
  "clientId"     INTEGER PRIMARY KEY,
  "totalCaw"     TEXT NOT NULL,
  "multiplier"   TEXT NOT NULL,
  "lastBlock"    BIGINT NOT NULL,
  "lastLogIndex" INTEGER NOT NULL,
  "updatedAt"    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Latest cawOwnership[tokenId] per token, mirroring contract state.
-- Cold-start avoids a full CawOwnershipSnapshot table scan to find
-- per-token most-recent rows. Daily reconciler reads this and asserts
-- equality with on-chain cawOwnership(tokenId).
CREATE TABLE IF NOT EXISTS "CawOwnershipCurrent" (
  "tokenId"   INTEGER PRIMARY KEY,
  "ownership" TEXT NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
