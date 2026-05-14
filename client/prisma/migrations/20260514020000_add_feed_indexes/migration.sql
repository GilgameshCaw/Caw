-- Audit 2026-05-13: 4 missing composite indexes on hot query paths +
-- 2 unused standalone indexes dropped.
--
-- Adds (each closes a specific query-shape gap):
--   * Caw(userId, status, createdAt)            — profile feed + main feed
--   * Follow(followerId, action, status)        — home-feed "do I follow?" filter
--   * Tip(recipientId, pending, createdAt)      — tips received view
--   * ConversationParticipant(userId, leftAt, status) — DM inbox load
--
-- Drops (single-column indexes that are never queried in isolation):
--   * Notification(createdAt)        — every real query path is (userId, ...)
--   * Conversation(lastMessageAt)    — almost always reached via ConversationParticipant
--
-- CONCURRENTLY on the CREATE side so write-heavy tables don't block on
-- migration. IF NOT EXISTS makes the migration idempotent (partial-replay
-- friendly per project_prisma_migrations). DROP INDEX without
-- CONCURRENTLY because the unused indexes are write-only — dropping
-- them only briefly blocks writes against the index itself, not the
-- table data.
--
-- Note for the operator: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If you're applying this via `prisma db execute`,
-- it does each statement separately so this is fine. If you're applying
-- via a transactional wrapper, the CREATE statements will fail and need
-- to be re-issued outside the transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Caw_userId_status_createdAt_idx"
  ON "Caw" ("userId", "status", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Follow_followerId_action_status_idx"
  ON "Follow" ("followerId", "action", "status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Tip_recipientId_pending_createdAt_idx"
  ON "Tip" ("recipientId", "pending", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ConversationParticipant_userId_leftAt_status_idx"
  ON "ConversationParticipant" ("userId", "leftAt", "status");

DROP INDEX IF EXISTS "Notification_createdAt_idx";

DROP INDEX IF EXISTS "Conversation_lastMessageAt_idx";
