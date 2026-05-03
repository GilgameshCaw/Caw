-- Add X (Twitter) account linkage to User. Tier-A "linked" verification:
-- the wallet proved control of the X handle via OAuth. Bucketed follower
-- count is captured at link time (and on user-initiated refresh) to avoid
-- continuous polling. xUserId is the unique key — handles can change but
-- the underlying X account id doesn't, and uniqueness gives us
-- first-link-wins enforcement at the DB level.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "xHandle"             TEXT,
  ADD COLUMN IF NOT EXISTS "xUserId"             TEXT,
  ADD COLUMN IF NOT EXISTS "xLinkedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "xFollowerBucket"     INTEGER,
  ADD COLUMN IF NOT EXISTS "xFollowersUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_xUserId_key"
  ON "User" ("xUserId");
