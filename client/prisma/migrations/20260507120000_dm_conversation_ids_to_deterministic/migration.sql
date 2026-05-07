-- Rewrite legacy DM Conversation.id values from Prisma's @default(uuid())
-- to the deterministic `dm:${min(userIdA,userIdB)}:${max(userIdA,userIdB)}`
-- form so cross-instance relay works on existing threads.
--
-- Why: dm-relay.ts (b00fa26) computes the expected conversationId
-- deterministically and rejects mismatches with 400 Invalid conversation
-- ID format. Conversations created before b00fa26 had Prisma generate a
-- UUID, so any new message in those threads would relay-out, hit the
-- receiver's check, and bounce. Without this backfill, every existing
-- DM thread on every node stays single-instance forever.
--
-- Idempotent: WHERE id !~ '^dm:[0-9]+:[0-9]+$' skips already-migrated
-- rows, so partial-replay (or re-running on a freshly-deployed node
-- that has no UUID rows) is a no-op.
--
-- Safety:
--   - Only DM rows; GROUP conversations keep their UUIDs (no min/max
--     pair shape applies).
--   - DM convs always have exactly two participants in this codebase
--     (verified manually pre-flight; no production-scale data yet).
--   - Foreign keys (Message.conversationId, ConversationParticipant
--     .conversationId) are ON UPDATE CASCADE, so updating
--     Conversation.id atomically rewrites all references.
--   - Wrapped in a transaction so a partial failure rolls back cleanly.

BEGIN;

-- Materialize the (oldId → newId) mapping in a temp table so we can
-- detect collisions BEFORE attempting any UPDATE. A collision would
-- mean two UUID-keyed conversations exist for the same (userA, userB)
-- pair — possible if a race during the buggy window created
-- duplicates. Fail loudly rather than silently merging.
CREATE TEMP TABLE _dm_id_remap AS
SELECT
  c.id AS old_id,
  'dm:' || min(p."userId")::text || ':' || max(p."userId")::text AS new_id
FROM "Conversation" c
JOIN "ConversationParticipant" p ON p."conversationId" = c.id
WHERE c.type = 'DM'
  AND c.id !~ '^dm:[0-9]+:[0-9]+$'
GROUP BY c.id
HAVING count(*) = 2;  -- skip malformed (>2-participant) DMs

DO $$
DECLARE
  collision_count int;
BEGIN
  SELECT count(*) - count(DISTINCT new_id) INTO collision_count FROM _dm_id_remap;
  IF collision_count > 0 THEN
    RAISE EXCEPTION 'DM conversation id collision: % duplicate (userA,userB) pairs detected. Resolve manually before re-running.', collision_count;
  END IF;
END $$;

-- Apply the remap. ON UPDATE CASCADE rewrites Message.conversationId
-- and ConversationParticipant.conversationId in lockstep.
UPDATE "Conversation" c
SET id = r.new_id
FROM _dm_id_remap r
WHERE c.id = r.old_id;

DROP TABLE _dm_id_remap;

COMMIT;
