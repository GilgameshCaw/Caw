-- Add SALE_SOLD (seller-side) and SALE_BOUGHT (buyer-side) to NotificationType.
-- Emitted by MarketplaceIndexerService when a Sale event lands. Auctions use
-- the existing AUCTION_WON path.
--
-- IF NOT EXISTS: required for re-runs against partially-migrated environments
-- (Postgres 9.6+). Without it, replaying this migration after a partial apply
-- errors with "enum label X already exists".
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SALE_SOLD';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SALE_BOUGHT';
