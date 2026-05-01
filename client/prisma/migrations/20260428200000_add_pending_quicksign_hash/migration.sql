-- Add TxQueue.pendingQuickSignTxHash: marks a row whose owner's session key
-- is registered in the same L1 tx (typically a bundled mintAndDepositAndQuickSign).
-- Mirror of pendingDepositTxHash. While non-null the validator should hold the
-- row instead of simulating, since the L2 sessions[owner][sessionKey] write may
-- not have landed yet. Cleared on SessionCreated event indexing.
ALTER TABLE "TxQueue" ADD COLUMN "pendingQuickSignTxHash" TEXT;
