-- v1 small-group chats (3-10 participants, all on same node).
-- Sealed-per-recipient encryption: Message.encryptedPayload is NULL for
-- group rows; per-recipient ciphertext lives in MessageRecipientPayload.

-- 1) ConversationType: add GROUP. Hand-rolled IF NOT EXISTS guard since
--    Postgres has no native ALTER TYPE ... ADD VALUE IF NOT EXISTS in
--    older versions and the deploy can re-run partially.
DO $$ BEGIN
  ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'GROUP';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2) ConversationParticipantRole — OWNER vs MEMBER. Owner-only writes
--    (add/remove/rename, mint/revoke invite) check this column.
DO $$ BEGIN
  CREATE TYPE "ConversationParticipantRole" AS ENUM ('OWNER', 'MEMBER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3) Conversation: name + avatarUrl (group metadata). Both nullable so
--    DM rows stay clean.
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "name"      TEXT,
  ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

-- 4) ConversationParticipant: role + leftAt. leftAt IS NULL means
--    "active member"; the participant lookup MUST add this filter so
--    removed members can't send/react/edit.
ALTER TABLE "ConversationParticipant"
  ADD COLUMN IF NOT EXISTS "role"   "ConversationParticipantRole" NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN IF NOT EXISTS "leftAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ConversationParticipant_conversationId_leftAt_idx"
  ON "ConversationParticipant" ("conversationId", "leftAt");

-- 5) Message.systemPayload — JSONB blob carrying system-event metadata
--    (added/removed userIds, oldName/newName, etc.). senderId on system
--    rows is the actor; encryptedPayload stays NULL.
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "systemPayload" JSONB;

-- 6) MessageRecipientPayload — sealed-per-recipient ciphertext for
--    group messages. One row per (message, recipient). Sender writes
--    encryptForRecipients() output as N rows in a single transaction.
CREATE TABLE IF NOT EXISTS "MessageRecipientPayload" (
    "id"                BIGSERIAL    PRIMARY KEY,
    "messageId"         TEXT         NOT NULL,
    "recipientUserId"   INTEGER      NOT NULL,
    "encryptedPayload"  TEXT         NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageRecipientPayload_messageId_fkey" FOREIGN KEY ("messageId")
        REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageRecipientPayload_recipientUserId_fkey" FOREIGN KEY ("recipientUserId")
        REFERENCES "DmIdentity"("userId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageRecipientPayload_messageId_recipientUserId_key"
  ON "MessageRecipientPayload" ("messageId", "recipientUserId");
CREATE INDEX IF NOT EXISTS "MessageRecipientPayload_recipientUserId_idx"
  ON "MessageRecipientPayload" ("recipientUserId");

-- 7) DmIdentity.allowGroupInvites — opt-out toggle. Default true so
--    existing users keep behavior. Hitting an invite URL overrides this
--    (explicit consent), so the column gates ONLY direct add-member.
ALTER TABLE "DmIdentity"
  ADD COLUMN IF NOT EXISTS "allowGroupInvites" BOOLEAN NOT NULL DEFAULT TRUE;

-- 8) GroupInvite — token-based invite URLs. uuid id keeps the row
--    addressable for revoke; token is the URL-safe random string.
CREATE TABLE IF NOT EXISTS "GroupInvite" (
    "id"              TEXT         PRIMARY KEY,
    "token"           TEXT         NOT NULL,
    "conversationId"  TEXT         NOT NULL,
    "createdByUserId" INTEGER      NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "maxUses"         INTEGER      NOT NULL,
    "useCount"        INTEGER      NOT NULL DEFAULT 0,
    "revokedAt"       TIMESTAMP(3),
    CONSTRAINT "GroupInvite_conversationId_fkey" FOREIGN KEY ("conversationId")
        REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupInvite_createdByUserId_fkey" FOREIGN KEY ("createdByUserId")
        REFERENCES "DmIdentity"("userId") ON DELETE NO ACTION ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "GroupInvite_token_key"
  ON "GroupInvite" ("token");
CREATE INDEX IF NOT EXISTS "GroupInvite_conversationId_idx"
  ON "GroupInvite" ("conversationId");
