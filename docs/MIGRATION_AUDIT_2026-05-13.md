# Migration safety audit — 2026-05-13

26 Prisma migrations on disk. 2 would-break-prod, 1 slow-but-tolerable, rest clean.

## CRITICAL: would-break-prod

### `20260429100000_add_txqueue_cawonce_unique/migration.sql`

**Issue.** Lines 24–26 do an unbatched `UPDATE "TxQueue" SET "cawonce" = (payload->'data'->>'cawonce')::int WHERE ...`. On a multi-million-row TxQueue this single statement takes an exclusive lock on the table for the entire UPDATE duration — could be hours under load. All transaction submissions block during that window.

**Status.** Already applied (per the directory existing). Whether this was painful at apply time depends on TxQueue volume at the time. **Future migrations of similar shape should batch.**

**Fix pattern for future:**

```sql
DO $$
DECLARE batch_size int := 10000;
BEGIN
  LOOP
    UPDATE "TxQueue" SET "cawonce" = (payload->'data'->>'cawonce')::int
    WHERE id IN (
      SELECT id FROM "TxQueue"
      WHERE payload->'data'->>'cawonce' IS NOT NULL AND "cawonce" IS NULL
      LIMIT batch_size
    );
    EXIT WHEN NOT FOUND;
    COMMIT; -- requires the migration to be run with autocommit, not a single tx
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;
```

### `20260507120000_dm_conversation_ids_to_deterministic/migration.sql`

**Issue.** Lines 56–59 rewrite Conversation.id PKs in-place. The migration is wrapped in a single transaction with collision detection upstream, but there's no down-migration — if a downstream consumer has cached old conversation IDs (e.g., the WebSocket service, mobile clients with offline caches), they break and there's no automated way back.

**Status.** Applied. Future similar PK-rewrite migrations should either (a) be done dual-write with a flip after backfill, or (b) include an explicit `down.sql` with the reverse mapping.

## SLOW-BUT-TOLERABLE

### `20260506000000_widen_shorturl_code/migration.sql`

**Issue.** Line 15 `ALTER COLUMN "code" TYPE VARCHAR(16)` from VARCHAR(10). PostgreSQL 11+ has fast-path optimizations for "extending varchar without USING" but it's not guaranteed across all configs. Could trigger a table rewrite on the ShortUrl table — depending on row count, 10s of minutes of write-locking.

**Status.** Applied. Probably fine in practice since ShortUrl is unlikely to be massive. Future similar type changes: prefer creating a new column + backfilling + renaming.

## COSMETIC

- `replace_pinned_at_with_pinned_caw_table/migration.sql` — uses `DROP COLUMN IF EXISTS` which silently skips if the column doesn't exist. Idempotent but reduces failure visibility. Low-priority cleanup.
- `add_group_conversations/migration.sql` — uses `DO $$ EXCEPTION WHEN duplicate_object THEN NULL END` blocks. Swallows errors other than duplicate. Cosmetic; consider re-raising non-duplicate exceptions.
- `00000000000000_init/migration.sql` — 150+ CREATE INDEX statements without `CONCURRENTLY`. Only runs on the empty DB at first deploy; no production impact. Just a reminder that future migrations on populated tables should add CONCURRENTLY.

## Clean

20 migrations had no safety findings: hashtag additions, marketplace/offer/sale schema, dm-relay dedup, polls, x-verification, etc.

## Recommendations

1. **Add a "migration safety checklist" doc** for future migrations: any UPDATE touching >100K rows must be batched; any CREATE INDEX on a populated table must use CONCURRENTLY; any PK rewrite needs an explicit rollback path.
2. **Consider a lint hook** that scans new migration SQL for the patterns above and warns at PR time. Doable with grep regexes.
3. **Document the WebSocket-consumer dependency** on Conversation.id format — if the format ever changes again, the DM service caches need an explicit invalidation step in the migration.
