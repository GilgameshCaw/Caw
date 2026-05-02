-- Add diagnostic provenance columns to TxQueue.
-- clientVersion: build-time git SHA from the FE that submitted (X-Caw-Client-Version header).
-- clientOrigin:  browser-supplied Origin header — needed as we onboard mirrors / FE-only peers.
-- Both nullable so old rows + non-FE submitters (curl, scripts) are fine.

ALTER TABLE "TxQueue" ADD COLUMN "clientVersion" TEXT;
ALTER TABLE "TxQueue" ADD COLUMN "clientOrigin" TEXT;
