-- Add VOTE to NotificationType so poll authors can be notified when
-- someone votes on their poll. IF NOT EXISTS so re-running the
-- migration on a partially-migrated DB is a no-op.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VOTE';
