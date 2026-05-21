# V2 local database setup

Pre-launch testnet — V2 schema is a clean break from V1 (Client → Network rename,
new per-fee ceilings, MarketplacePayout tracking, SessionKey.profileId).

## One-time setup

```bash
# 1. Create the V2 Postgres database
createdb caw_v2_local

# 2. Set DATABASE_URL in client/.env to point at it
#    (already done in client/.env.example as the new default)
echo 'DATABASE_URL=postgresql://localhost:5432/caw_v2_local' >> client/.env

# 3. Materialize the schema (creates all tables from schema.prisma)
cd client && npx prisma db push

# 4. Regenerate the Prisma client (already done; re-run after schema edits)
npx prisma generate
```

## What changed in V2

| Area | V1 | V2 |
|---|---|---|
| Protocol entity | `Client` model, `client_id` column | `Network` model, `network_id` column |
| Auth table | `ClientAuth` (`clientId`, `tokenId`) | `NetworkAuth` (`networkId`, `tokenId`) |
| Replication tracking | `ReplicationTx.clientId` | `ReplicationTx.networkId` |
| Stake ledger state | `StakeLedgerState.clientId` (PK) | `StakeLedgerState.networkId` (PK) |
| Network fee ceilings | (none) | `Network.withdrawFeeCeiling/depositFeeCeiling/authFeeCeiling/mintFeeCeiling` (BigInt) |
| Token-scoped sessions | (none) | `SessionKey.profileId` (0 = wallet-scoped, non-zero = token-scoped) |
| Marketplace payouts | (none) | `MarketplacePayout` table (event-sourced, PayoutQueued/PayoutWithdrawn) |

## Migration SQL

The hand-rolled migration is at:
`client/prisma/migrations/20260522000000_v2_schema_network_rename_ceilings_profileid_payout/migration.sql`

For a fresh V2 DB (`prisma db push` path) the ALTER TABLE statements in the migration are
no-ops — Prisma creates the tables with the V2 names directly. For an upgrade from a
V1 database, un-comment the ALTER TABLE / RENAME statements first, then apply.

Apply with:
```bash
cd client
npx prisma db execute --file prisma/migrations/20260522000000_v2_schema_network_rename_ceilings_profileid_payout/migration.sql
```

## V1 DB

The V1 database (default name `caw_local` / `caw_dev`) is untouched. If you need
read-only access to V1 data for migration reference, point a separate script at it
via `DATABASE_URL_V1` and a parallel Prisma client instance (do not point
the main `DATABASE_URL` at it while V2 code is running).

## On the VPS

When deploying via the CLI installer (`caw install`), the installer prompts for a
database name. Use a fresh name (e.g. `caw_v2`) so the V1 install at
test.caw.social remains independent.

Env vars to update on the VPS alongside the DB rename:
- `CAW_NETWORK_MANAGER_ADDRESS` — V2 CawNetworkManager address (replaces V1 ClientManager)
- `REPLICATE_NETWORK_IDS` — replaces `REPLICATE_CLIENT_IDS` in ValidatorService
- `CAW_ACTIONS_ERC1271_ADDRESS` — new V2 sibling contract address
