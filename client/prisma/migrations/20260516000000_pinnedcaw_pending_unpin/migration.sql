-- Add a separate flag for unpin-in-flight rows so the read path can
-- suppress them. The existing `pending` boolean covers pin-in-flight
-- (row exists but isn't confirmed yet); `pendingUnpin` covers the
-- inverse case (row is confirmed but a pending xpi: action wants to
-- delete it). Without this split, an unpin in flight leaves the row
-- visible on the profile feed until the indexer confirms.
ALTER TABLE "PinnedCaw" ADD COLUMN IF NOT EXISTS "pendingUnpin" BOOLEAN NOT NULL DEFAULT false;
