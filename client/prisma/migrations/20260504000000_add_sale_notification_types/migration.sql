-- Add SALE_SOLD (seller-side) and SALE_BOUGHT (buyer-side) to NotificationType.
-- Emitted by MarketplaceIndexerService when a Sale event lands. Auctions use
-- the existing AUCTION_WON path.
ALTER TYPE "NotificationType" ADD VALUE 'SALE_SOLD';
ALTER TYPE "NotificationType" ADD VALUE 'SALE_BOUGHT';
