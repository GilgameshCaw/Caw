-- Collapse duplicate open NotificationGroup buckets and add a partial
-- unique index so the runtime INSERT … ON CONFLICT path is atomic.
--
-- Background: the original migration used a 15-minute open-window when
-- deciding whether to attach a new notification to an existing group.
-- Notifications arriving more than 15 minutes apart on the same post
-- opened fresh groups, producing multiple "X others liked your caw"
-- rows for the same post. The runtime now treats groups as open while
-- unread (no time limit), so here we merge the legacy duplicates before
-- the index enforces at-most-one.
--
-- Step A: merge duplicate open buckets
-- Step B: add the partial unique index
--
-- All DDL uses IF NOT EXISTS per feedback_migration_if_not_exists.md.

DO $$
DECLARE
  bucket_row RECORD;
  survivor_id INTEGER;
  loser_ids   INTEGER[];
  total_count INTEGER;
  latest_last_event TIMESTAMP;
  latest_notif_id   INTEGER;
BEGIN
  -- Step A: For each (userId, type, COALESCE(targetKey,'')) bucket that
  -- has more than one unread NotificationGroup row, pick the survivor
  -- (oldest openedAt = first-opened wins), sum counts, take the latest
  -- lastEventAt, and point the latest notification id appropriately.
  --
  -- We walk buckets one at a time to keep the logic clear. The number
  -- of affected buckets is expected to be O(users × notification types)
  -- which is small enough that a cursor loop is fine.

  FOR bucket_row IN
    SELECT
      g."userId",
      g."type",
      COALESCE(g."targetKey", '') AS coalesced_key,
      g."targetKey",
      COUNT(*) AS dup_count
    FROM "NotificationGroup" g
    WHERE g."isRead" = false
    GROUP BY g."userId", g."type", COALESCE(g."targetKey", ''), g."targetKey"
    HAVING COUNT(*) > 1
    ORDER BY g."userId", g."type", COALESCE(g."targetKey", '')
  LOOP
    -- Collect all group ids for this open bucket, oldest first.
    SELECT
      MIN(g.id)  -- survivor = lowest id (earliest insert = oldest openedAt)
    INTO survivor_id
    FROM "NotificationGroup" g
    WHERE g."userId"  = bucket_row."userId"
      AND g."type"    = bucket_row."type"
      AND COALESCE(g."targetKey", '') = bucket_row.coalesced_key
      AND g."isRead"  = false;

    SELECT array_agg(g.id ORDER BY g.id)
    INTO loser_ids
    FROM "NotificationGroup" g
    WHERE g."userId"  = bucket_row."userId"
      AND g."type"    = bucket_row."type"
      AND COALESCE(g."targetKey", '') = bucket_row.coalesced_key
      AND g."isRead"  = false
      AND g.id <> survivor_id;

    -- Sum counts and find the row with the latest lastEventAt.
    SELECT
      SUM(g."count"),
      MAX(g."lastEventAt")
    INTO total_count, latest_last_event
    FROM "NotificationGroup" g
    WHERE g."userId"  = bucket_row."userId"
      AND g."type"    = bucket_row."type"
      AND COALESCE(g."targetKey", '') = bucket_row.coalesced_key
      AND g."isRead"  = false;

    -- The latestNotificationId of whichever row had the latest lastEventAt.
    SELECT g."latestNotificationId"
    INTO latest_notif_id
    FROM "NotificationGroup" g
    WHERE g."userId"  = bucket_row."userId"
      AND g."type"    = bucket_row."type"
      AND COALESCE(g."targetKey", '') = bucket_row.coalesced_key
      AND g."isRead"  = false
    ORDER BY g."lastEventAt" DESC
    LIMIT 1;

    -- Re-point all Notification rows that pointed at a loser group.
    UPDATE "Notification"
      SET "groupId" = survivor_id
      WHERE "groupId" = ANY(loser_ids);

    -- Update the survivor with the merged stats.
    UPDATE "NotificationGroup"
      SET "count"                = total_count,
          "lastEventAt"          = latest_last_event,
          "latestNotificationId" = latest_notif_id
      WHERE id = survivor_id;

    -- Delete the losers.
    DELETE FROM "NotificationGroup"
      WHERE id = ANY(loser_ids);

  END LOOP;

END $$;

-- Step B: Add the partial unique index that the runtime ON CONFLICT
-- path requires.
--
-- Conflict target: (userId, type, COALESCE(targetKey, '')) WHERE isRead = false
--
-- COALESCE('') is used instead of NULLS NOT DISTINCT because the deploy
-- target runs PG 14 (NULLS NOT DISTINCT requires PG 15+). The runtime
-- INSERT uses the same COALESCE expression so the expressions match.
--
-- Step A must have removed all duplicates before this line; if any
-- remain the CREATE UNIQUE INDEX will fail and the whole migration
-- block errors out clearly.

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationGroup_open_bucket_uniq"
  ON "NotificationGroup" ("userId", "type", (COALESCE("targetKey", '')))
  WHERE "isRead" = false;
