-- Cache the L2 on-chain CAW staked balance on the User row so the
-- /api/users/by-token endpoint can read it from the DB instead of calling
-- cawBalanceOf on every request. Refreshed by DataCleaner on its 1-minute
-- pass for users with pendingDepositAmount set. Tier 2 of the "RPC out of
-- API request handlers" refactor — see PROJECT_BACKLOG.md.
ALTER TABLE "User"
  ADD COLUMN "onChainStakeWei"       TEXT,
  ADD COLUMN "onChainStakeUpdatedAt" TIMESTAMP(3);
