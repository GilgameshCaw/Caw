-- Per-action validator tip baked into Quick-Sign sessions at registration.
-- Session-signed actions sign with empty `amounts[]`; the contract reads
-- this rate from the session record and credits the validator once at
-- batch end (gas optimization — replaces per-action addToBalance SSTOREs
-- with one batch-end SSTORE).

ALTER TABLE "SessionKey"
  ADD COLUMN IF NOT EXISTS "perActionTipRate" TEXT NOT NULL DEFAULT '0';

-- Stamp signer kind + pre-resolved implicit tip on TxQueue rows so the
-- validator's gas-coverage check can read them without re-recovering the
-- signer or re-querying the SessionKey table per action.
ALTER TABLE "TxQueue"
  ADD COLUMN IF NOT EXISTS "signerKind"  TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS "implicitTip" TEXT;
