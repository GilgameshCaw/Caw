-- Marketplace price/amount columns: text -> numeric.
--
-- These held 18-decimal wei values as TEXT, so every Prisma orderBy on them
-- sorted lexicographically ("1000000000000000000" < "90000000000000000") and
-- the API had to fetch every matching row and sort in process. NUMERIC(78,0)
-- holds the full uint256 range exactly (BIGINT tops out at ~9.2 ETH in wei),
-- sorts correctly in the database, and Prisma's Decimal serialises back to
-- the same digit string the frontend already consumes.
--
-- Existing values are plain digit strings written by the indexer via
-- BigInt.toString(), so the USING cast is exact. NULLIF guards the nullable
-- columns against an empty string from any early row.

ALTER TABLE "MarketplaceListing"
  ALTER COLUMN "startPrice" TYPE DECIMAL(78,0) USING "startPrice"::numeric,
  ALTER COLUMN "endPrice"   TYPE DECIMAL(78,0) USING NULLIF("endPrice", '')::numeric,
  ALTER COLUMN "highestBid" TYPE DECIMAL(78,0) USING NULLIF("highestBid", '')::numeric;

ALTER TABLE "MarketplaceBid"
  ALTER COLUMN "amount" TYPE DECIMAL(78,0) USING "amount"::numeric;

ALTER TABLE "MarketplaceSale"
  ALTER COLUMN "price" TYPE DECIMAL(78,0) USING "price"::numeric;

ALTER TABLE "MarketplaceOffer"
  ALTER COLUMN "amount" TYPE DECIMAL(78,0) USING "amount"::numeric;
