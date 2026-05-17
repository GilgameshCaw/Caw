-- Audit 2026-05-13: four composite indexes that were added to schema.prisma
-- but never landed in a migration file. All are IF NOT EXISTS per policy.

-- Caw: covers `where: { userId, status: 'SUCCESS' } orderBy: { createdAt: desc }`
-- (profile-feed + main-feed dominant query shape).
CREATE INDEX IF NOT EXISTS "Caw_userId_status_createdAt_idx" ON "Caw"("userId", "status", "createdAt");

-- Follow: covers home-feed "is this author in my follows?" check:
-- `where: { followerId, action: 'FOLLOW', status: 'SUCCESS' }`.
CREATE INDEX IF NOT EXISTS "Follow_followerId_action_status_idx" ON "Follow"("followerId", "action", "status");

-- Tip: covers "tips received on profile" view:
-- `where: { recipientId, pending: false } orderBy: { createdAt: desc }`.
CREATE INDEX IF NOT EXISTS "Tip_recipientId_pending_createdAt_idx" ON "Tip"("recipientId", "pending", "createdAt");

-- ConversationParticipant: covers DM inbox queries filtering by
-- `userId + leftAt IS NULL + optional status = 'REQUEST'`.
CREATE INDEX IF NOT EXISTS "ConversationParticipant_userId_leftAt_status_idx" ON "ConversationParticipant"("userId", "leftAt", "status");
