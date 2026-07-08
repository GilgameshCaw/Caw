-- Add a redemption lifecycle status so the sponsor-bootstrap flow can RESERVE an
-- invite use BEFORE the irreversible on-chain mint and finalize/refund after —
-- closing the window where a lost response (e.g. a 502 during a deploy restart)
-- left a free, un-audited mint. 'reserved' = decremented pre-mint; 'finalized' =
-- mint confirmed; 'refunded' = mint failed, use re-incremented. Existing rows were
-- all written post-mint by the old commitRedemption, so default them to 'finalized'.
ALTER TABLE "SponsorRedemption" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'finalized';
