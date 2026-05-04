# Migrations — operator guide

Short reference for running an existing CAW node through schema changes. Authors of new migrations should also read `feedback_migration_if_not_exists.md` (the always-add-IF-NOT-EXISTS rule) and the smell check in `cli/src/steps/update.js`.

## Normal flow

`caw update` does the right thing:

1. `git pull --ff-only`
2. `prisma migrate deploy` — applies any pending migrations
3. **Schema verification** — confirms the live DB has every table and scalar column declared in `schema.prisma`. Aborts the update if anything is missing.
4. Frontend rebuild (only if FE files changed)
5. `pm2 restart` (only after every check above passes)

The verifier in step 3 is the safety net for the failure mode below. If it fails, the service is **not** restarted — your existing pm2 process keeps serving traffic against the schema it was built for.

## Recovery: `prisma migrate resolve` left the DB drifted

Symptom: `caw update` aborts at step 3 with output like:

```
✗ Database schema does NOT match schema.prisma

  Missing columns:
    - TxQueue.clientVersion
    - TxQueue.clientOrigin
    - User.xBadgeVisible
  Missing tables:
    - WalletXLink

  This usually means a migration was marked applied via
  `prisma migrate resolve` without actually running its SQL.
```

This happens when an operator (or an AI helper) tells Prisma a migration is done without actually running the SQL — `_prisma_migrations` reads clean and `prisma migrate deploy` skips it on subsequent runs, but the columns/tables it would have created aren't there.

### Fix it by hand

Every CAW migration is written to be idempotent (`IF NOT EXISTS` / `ADD VALUE IF NOT EXISTS`) so re-running its SQL on top of a partially-applied DB is safe.

```bash
cd /var/www/<your-domain>

# 1. Find the migration that adds a missing column or table:
grep -rl "xBadgeVisible" client/prisma/migrations/
# → client/prisma/migrations/20260503000000_wallet_x_link/migration.sql

# 2. Apply it directly. DATABASE_URL is in client/.env.
psql "$(grep ^DATABASE_URL= client/.env | cut -d= -f2-)" \
  -f client/prisma/migrations/20260503000000_wallet_x_link/migration.sql

# 3. Repeat for any other migration the verifier flagged.

# 4. Re-run the update. The verifier should pass and pm2 will restart.
caw update
```

If you have many missing columns spread across several migrations, the simplest brute force is to rerun every migration's `migration.sql` in order — they're all safe to replay.

### Escape hatch (use sparingly)

`caw update --skip-verify-schema` proceeds past the verifier. Reach for this only when you know exactly what's mismatched and that it's intentional (e.g. a column you removed by hand and the schema hasn't been updated yet). Fix the underlying drift and remove the flag on the next run.

## What the verifier does and doesn't check

It checks:

- Every model declared in `schema.prisma` has a matching `public.<ModelName>` table.
- Every scalar field (primitive type or enum) has a matching column on that table.

It does **not** check:

- Column types (a `String` column declared as `Int` in the DB will pass).
- Nullability (`@?` is not enforced).
- Indexes, unique constraints, or foreign keys.
- Relation fields (those don't have DB columns).

This is intentional: the failure mode it exists to catch is "column entirely missing." Type drift is rare in practice and would need a Prisma↔Postgres type-mapping table that's bigger than the bug.

## Author note: `@@map`

The verifier asserts that no model uses `@@map(...)`. None do today. If you need to add one — e.g. to rename a Prisma model without renaming the underlying table — also update `parsePrismaSchemaTables` in `cli/src/steps/update.js` to honor the override. The assertion will fail loudly to remind you.
