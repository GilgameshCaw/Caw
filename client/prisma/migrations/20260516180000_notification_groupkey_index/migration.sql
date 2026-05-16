-- Speeds up the GROUP BY query in GET /api/notifications that buckets
-- a user's notifications by groupKey for the rollup display. Without
-- this, fetching the notifications page for users with thousands of
-- rows did a full scan + HashAggregate (~hundreds of ms for the heavy
-- users on test.caw.social with ~4K rows). With this index Postgres
-- can group via an index-only scan.
CREATE INDEX IF NOT EXISTS "Notification_userId_groupKey_createdAt_idx"
  ON "Notification" ("userId", "groupKey", "createdAt");
