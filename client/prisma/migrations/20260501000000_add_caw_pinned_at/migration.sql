-- Profile pin: a single Caw per user can be pinned to the top of their
-- profile feed. NULL means not pinned; a timestamp means pinned at that
-- moment. Single-pin enforcement lives in the indexer (and the API
-- fallback) — pinning a new post nulls every other pinned post owned by
-- the same user in the same transaction.
--
-- Hand-rolled to match the pattern used by other migrations in this
-- repo (the shadow DB is drifted from migration history).

ALTER TABLE "Caw"
  ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Caw_userId_pinnedAt_idx"
  ON "Caw" ("userId", "pinnedAt");
