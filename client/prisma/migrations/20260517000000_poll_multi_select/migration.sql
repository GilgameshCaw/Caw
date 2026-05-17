-- Multi-select polls. New Poll.multiSelect flag (default false =
-- single-select, the existing behavior) plus a widened Vote
-- uniqueness key so multi-select polls can carry multiple Vote rows
-- per voter (one per picked option).

ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "multiSelect" BOOLEAN NOT NULL DEFAULT false;

-- Drop the old (pollId, voterId) unique constraint and replace with
-- (pollId, voterId, optionIndex). Existing rows are safe: the old
-- constraint guaranteed one row per (pollId, voterId), so the new
-- triple is automatically unique. Wrap in DO block to tolerate the
-- constraint name being different across environments.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  -- Find the existing UNIQUE constraint on (pollId, voterId).
  SELECT conname INTO con_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'Vote' AND c.contype = 'u' AND con_name IS NULL
    AND (
      SELECT array_agg(attname ORDER BY a.attnum)
      FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
    ) = ARRAY['pollId', 'voterId'];

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "Vote" DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- Create the new uniqueness constraint via a unique index — Prisma's
-- @@unique([pollId, voterId, optionIndex]) generates an index named
-- Vote_pollId_voterId_optionIndex_key on prisma migrate deploy.
CREATE UNIQUE INDEX IF NOT EXISTS "Vote_pollId_voterId_optionIndex_key"
  ON "Vote" ("pollId", "voterId", "optionIndex");
