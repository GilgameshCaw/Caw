-- Backfill migration: repairs residual schema drift between the replayed
-- migration history and schema.prisma (see `prisma migrate diff` output).
--
-- This migration ONLY contains `ALTER TYPE ... ADD VALUE` statements.
-- Postgres cannot run ADD VALUE inside the same transaction as other DDL
-- (and, on older PG, not more than one ADD VALUE per enum per transaction
-- either, if that value is then referenced in the same transaction). Prisma
-- wraps each migration file in its own transaction, so these are split into
-- their own migration, separate from 20260823000100_backfill_schema_drift.
--
-- All statements use IF NOT EXISTS so this migration is a no-op if any of
-- these values were already added by a prior partial apply.

-- CawStatus: HIDDEN (moderation hide action; see project_other_action_subtypes.md hide: prefix)
ALTER TYPE "CawStatus" ADD VALUE IF NOT EXISTS 'HIDDEN';

-- NotificationType: auction/bid + failed-action notifications
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OUTBID';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AUCTION_WON';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ACTION_FAILED';

-- ReportReason: additional moderation report categories
ALTER TYPE "ReportReason" ADD VALUE IF NOT EXISTS 'EXPLICIT';
ALTER TYPE "ReportReason" ADD VALUE IF NOT EXISTS 'ILLEGAL_HARMFUL';
