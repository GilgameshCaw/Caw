-- Multi-select polls. New Poll.multiSelect flag (default false =
-- single-select, the existing behavior) plus a widened Vote
-- uniqueness key so multi-select polls can carry multiple Vote rows
-- per voter (one per picked option).

ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "multiSelect" BOOLEAN NOT NULL DEFAULT false;

-- Swap the Vote uniqueness key from (pollId, voterId) to
-- (pollId, voterId, optionIndex). The original was a Prisma-generated
-- UNIQUE INDEX named Vote_pollId_voterId_key (NOT a UNIQUE CONSTRAINT
-- — Prisma's @@unique compiles to bare unique indexes). DROP INDEX
-- by name; IF EXISTS handles fresh DBs that never had the old index.
-- Existing rows are safe under the new triple: the old index already
-- guaranteed one row per (pollId, voterId), so adding optionIndex
-- preserves uniqueness on every existing row.
DROP INDEX IF EXISTS "Vote_pollId_voterId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Vote_pollId_voterId_optionIndex_key"
  ON "Vote" ("pollId", "voterId", "optionIndex");
