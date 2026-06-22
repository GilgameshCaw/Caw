-- /api/sponsor/my-codes filters by purchasedByTokenId and sorts by createdAt desc.
-- Replace the single-column index with a composite so the filter+sort is served
-- entirely by the index (no in-memory sort). Leading column still covers any
-- plain purchasedByTokenId lookup, so nothing regresses.

DROP INDEX "PurchasedInviteCode_purchasedByTokenId_idx";

CREATE INDEX "PurchasedInviteCode_purchasedByTokenId_createdAt_idx"
  ON "PurchasedInviteCode"("purchasedByTokenId", "createdAt" DESC);
