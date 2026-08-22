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
-- IF NOT EXISTS makes the migration idempotent (partial-replay friendly
-- per project_prisma_migrations). DROP INDEX without CONCURRENTLY
-- because the unused indexes are write-only — dropping them only
-- briefly blocks writes against the index itself, not the table data.
--
-- NOTE: this migration originally used CREATE INDEX CONCURRENTLY, but
-- `prisma migrate deploy` (and `prisma db execute`, as of current
-- Prisma versions) wraps each migration file in a single transaction,
-- and CONCURRENTLY cannot run inside a transaction block at all —
-- Postgres rejects it before even evaluating IF NOT EXISTS. These four
-- indexes are also created (non-concurrently) by the same-day migration
-- 20260513000000_add_feed_indexes, so by the time this file runs the
-- indexes already exist and these statements are no-ops; dropping
-- CONCURRENTLY here just makes that no-op actually replayable instead
-- of erroring out. If a truly concurrent build is ever needed against a
-- live write-heavy table, run the CONCURRENTLY form by hand outside of
-- migrate deploy.

CREATE INDEX IF NOT EXISTS "Caw_userId_status_createdAt_idx"
  ON "Caw" ("userId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "Follow_followerId_action_status_idx"
  ON "Follow" ("followerId", "action", "status");

CREATE INDEX IF NOT EXISTS "Tip_recipientId_pending_createdAt_idx"
  ON "Tip" ("recipientId", "pending", "createdAt");

CREATE INDEX IF NOT EXISTS "ConversationParticipant_userId_leftAt_status_idx"
  ON "ConversationParticipant" ("userId", "leftAt", "status");

DROP INDEX IF EXISTS "Notification_createdAt_idx";

DROP INDEX IF EXISTS "Conversation_lastMessageAt_idx";
