-- Add the end-time column for poll voting windows. NULL means the poll
-- has no expiry (legacy polls created before the ::pd:<dur>:: marker
-- sidecar was added).
ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "endsAt" TIMESTAMP(3);
