-- Passkey-wallet relay accounting: per-tx gas SPENT vs fee RECEIVED, so the
-- operator can prove the validator isn't losing money relaying executeBatch.

CREATE TABLE "RelayExecution" (
  "id"             SERIAL PRIMARY KEY,
  "txHash"         TEXT NOT NULL,
  "smartEoa"       TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "gasSpentWei"    TEXT NOT NULL,
  "feeCurrency"    TEXT NOT NULL,
  "feeReceivedWei" TEXT NOT NULL,
  "cawPerEthWei"   TEXT,
  "relayedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- One row per relayed tx.
CREATE UNIQUE INDEX "RelayExecution_txHash_key" ON "RelayExecution"("txHash");

CREATE INDEX "RelayExecution_smartEoa_idx"    ON "RelayExecution"("smartEoa");
CREATE INDEX "RelayExecution_relayedAt_idx"   ON "RelayExecution"("relayedAt");
CREATE INDEX "RelayExecution_feeCurrency_idx" ON "RelayExecution"("feeCurrency");
