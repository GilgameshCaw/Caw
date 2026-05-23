-- Add composite-unique constraint on WithdrawalRequest(userId, cawonce)
-- Guards against concurrent replay creating two rows for the same withdrawal.
-- IF NOT EXISTS per feedback_migration_if_not_exists.md.
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_userId_cawonce_unique"
  ON "WithdrawalRequest"("userId", "cawonce");
