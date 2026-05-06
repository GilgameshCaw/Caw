-- Cross-node DM relay groundwork:
--   1) Message.relayId — unique-when-set dedup key. The home node
--      generates a UUID per relay; receivers reject replays via the
--      unique index. Existing rows stay null (no relay ever ran).
--   2) ConversationParticipant.status — REQUEST / ACCEPTED / BLOCKED so
--      DMs from senders without a consent baseline can land in a
--      Requests inbox the recipient opts into rather than the main
--      inbox. Default ACCEPTED so existing conversations stay visible.

-- 1) Message.relayId
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "relayId" TEXT;

-- Partial unique index: NULL repeats are fine (every existing row).
-- Postgres treats NULLs as distinct in unique indexes by default, but
-- being explicit with WHERE NOT NULL keeps the index small and the
-- intent obvious.
CREATE UNIQUE INDEX IF NOT EXISTS "Message_relayId_key"
  ON "Message" ("relayId")
  WHERE "relayId" IS NOT NULL;

-- 2) ConversationParticipantStatus enum
DO $$ BEGIN
  CREATE TYPE "ConversationParticipantStatus" AS ENUM ('ACCEPTED', 'REQUEST', 'BLOCKED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3) ConversationParticipant.status — default ACCEPTED so legacy rows
--    inherit the existing behavior. New REQUEST rows are created only
--    by the relay receiver when there's no consent baseline.
ALTER TABLE "ConversationParticipant"
  ADD COLUMN IF NOT EXISTS "status" "ConversationParticipantStatus" NOT NULL DEFAULT 'ACCEPTED';

-- Index for the inbox-tab query: list a user's REQUEST conversations
-- without scanning their entire participant set. The (userId, status)
-- shape covers the common /api/dm/conversations?inbox=requests query.
CREATE INDEX IF NOT EXISTS "ConversationParticipant_userId_status_idx"
  ON "ConversationParticipant" ("userId", "status");
