-- Denormalize cawonce out of payload JSON onto a real column, then add a
-- partial unique index that catches duplicate (senderId, cawonce) pairs at
-- insert time for rows that are still actively trying to land. Replaces
-- the CawonceReservation system, which had a per-server view that broke
-- as soon as the same token was used across multiple installs (the
-- chain-only frontend allocation in the previous commit is the new
-- source of truth; this index is the safety net for the unavoidable
-- cross-tab / cross-server race window).
--
-- Status filter on the partial index intentionally:
--   - INCLUDES: pending, processing, awaiting_indexer, waiting_for_deposit
--     (rows that genuinely still occupy that cawonce slot)
--   - EXCLUDES: failed, retried, underpriced, done
--     (terminal-or-rolled-over states; their cawonce is no longer
--      claimed by this row)
-- This matters because the existing retry flow inserts a new row with
-- the SAME cawonce after marking the original 'retried'. Without the
-- partial filter, the unique constraint would block legit retries.

ALTER TABLE "TxQueue" ADD COLUMN "cawonce" INTEGER;

-- Backfill from payload->data->cawonce. Cast through TEXT then INTEGER
-- because JSON numbers come out of jsonb as numeric.
UPDATE "TxQueue"
   SET "cawonce" = (payload->'data'->>'cawonce')::int
 WHERE payload->'data'->>'cawonce' IS NOT NULL;

CREATE UNIQUE INDEX "TxQueue_senderId_cawonce_active_unique"
    ON "TxQueue" ("senderId", "cawonce")
 WHERE status IN ('pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit')
   AND "cawonce" IS NOT NULL;
