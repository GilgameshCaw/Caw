-- Add actionType column to RewardMultiplierSnapshot so the activity
-- page can show "CAW distributed to stakers" broken down by action
-- type at the system level. Nullable for the legacy rows that pre-
-- date this column.
ALTER TABLE "RewardMultiplierSnapshot"
  ADD COLUMN IF NOT EXISTS "actionType" TEXT;
