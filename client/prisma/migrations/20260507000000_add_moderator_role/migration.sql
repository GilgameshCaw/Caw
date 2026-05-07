-- Moderator tier: User.role + ModeratorAction audit log.
--
-- Roles are wallet-bound (no shared password). Admins promote users via
-- POST /api/admin/users/:tokenId/role. Bootstrap from BOOTSTRAP_ADMIN_TOKEN_IDS
-- env var on the very first deploy.
--
-- ModeratorAction is append-only — every mutation a moderator-or-admin
-- performs gets a row, so admins can audit "who hid which caw."

DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role" "UserRole" NOT NULL DEFAULT 'USER';

CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User" ("role");

CREATE TABLE IF NOT EXISTS "ModeratorAction" (
  "id"            SERIAL PRIMARY KEY,
  "actorTokenId"  INTEGER,
  "type"          TEXT      NOT NULL,
  "targetCawId"   INTEGER,
  "targetUserId"  INTEGER,
  "reason"        TEXT,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- FK to User.tokenId; ON DELETE SET NULL so a deleted moderator's audit
-- trail survives.
DO $$ BEGIN
  ALTER TABLE "ModeratorAction"
    ADD CONSTRAINT "ModeratorAction_actorTokenId_fkey"
    FOREIGN KEY ("actorTokenId") REFERENCES "User" ("tokenId")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ModeratorAction_actorTokenId_createdAt_idx"
  ON "ModeratorAction" ("actorTokenId", "createdAt");
CREATE INDEX IF NOT EXISTS "ModeratorAction_type_createdAt_idx"
  ON "ModeratorAction" ("type", "createdAt");
CREATE INDEX IF NOT EXISTS "ModeratorAction_targetCawId_idx"
  ON "ModeratorAction" ("targetCawId");
CREATE INDEX IF NOT EXISTS "ModeratorAction_targetUserId_idx"
  ON "ModeratorAction" ("targetUserId");
