-- Add notificationTipRequired to User.
-- A value of 0 (default) disables the gate; non-zero requires the
-- mentioning caw to carry an embedded tip of at least this many whole
-- CAW units directed at the mentioned user before a Notification row
-- is created.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notificationTipRequired" INTEGER NOT NULL DEFAULT 0;
