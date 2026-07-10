-- Fix: createNotificationWithGroup (NotificationService.ts) does
--   INSERT ... ON CONFLICT ("userId","type", COALESCE("targetKey", '')) WHERE "isRead" = false ...
-- but the matching PARTIAL UNIQUE INDEX was never created. The
-- 20260516200000_notification_groups migration created only a plain
-- (non-unique) index on (userId, type, targetKey, isRead, lastEventAt). So the
-- upsert fails on every call with:
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
-- => notification grouping is broken for ALL types (ACTION_FAILED just logs and
-- swallows it; others surface the raw error). This adds the missing index.
--
-- Because the index is UNIQUE, any pre-existing DUPLICATE open groups (same
-- userId, type, COALESCE(targetKey,'') with isRead=false — which the broken
-- upsert could have created by always taking the INSERT branch) must be merged
-- first, or CREATE UNIQUE INDEX fails.

-- 1) Merge duplicate OPEN groups into the earliest (lowest id) survivor per
--    (userId, type, COALESCE(targetKey,'')) bucket. Reassign the losers'
--    notifications to the survivor, roll the count up, and keep the freshest
--    lastEventAt + its latestNotificationId. Then delete the losers.
DO $$
DECLARE
  bucket RECORD;
  survivor_id INT;
  merged_count INT;
  latest_notif INT;
  latest_at TIMESTAMP;
BEGIN
  FOR bucket IN
    SELECT "userId", "type", COALESCE("targetKey", '') AS ckey
    FROM "NotificationGroup"
    WHERE "isRead" = false
    GROUP BY "userId", "type", COALESCE("targetKey", '')
    HAVING COUNT(*) > 1
  LOOP
    -- Earliest group in the bucket is the survivor.
    SELECT id INTO survivor_id
    FROM "NotificationGroup"
    WHERE "userId" = bucket."userId"
      AND "type" = bucket."type"
      AND COALESCE("targetKey", '') = bucket.ckey
      AND "isRead" = false
    ORDER BY id ASC
    LIMIT 1;

    -- Move every notification from the losing groups onto the survivor.
    UPDATE "Notification" n
    SET "groupId" = survivor_id
    WHERE n."groupId" IN (
      SELECT id FROM "NotificationGroup"
      WHERE "userId" = bucket."userId"
        AND "type" = bucket."type"
        AND COALESCE("targetKey", '') = bucket.ckey
        AND "isRead" = false
        AND id <> survivor_id
    );

    -- Recompute the survivor's rollup from its (now-merged) member set.
    SELECT COUNT(*) INTO merged_count
    FROM "Notification" WHERE "groupId" = survivor_id;

    SELECT id, "createdAt" INTO latest_notif, latest_at
    FROM "Notification"
    WHERE "groupId" = survivor_id
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1;

    UPDATE "NotificationGroup"
    SET "count" = GREATEST(merged_count, 1),
        "latestNotificationId" = COALESCE(latest_notif, "latestNotificationId"),
        "lastEventAt" = COALESCE(latest_at, "lastEventAt")
    WHERE id = survivor_id;

    -- Drop the now-empty losing groups.
    DELETE FROM "NotificationGroup"
    WHERE "userId" = bucket."userId"
      AND "type" = bucket."type"
      AND COALESCE("targetKey", '') = bucket.ckey
      AND "isRead" = false
      AND id <> survivor_id;
  END LOOP;
END $$;

-- 2) Create the partial UNIQUE index the runtime ON CONFLICT target requires.
--    The expression + predicate must match NotificationService.ts EXACTLY:
--      ("userId", "type", COALESCE("targetKey", '')) WHERE "isRead" = false
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationGroup_open_bucket_key"
  ON "NotificationGroup" ("userId", "type", (COALESCE("targetKey", '')))
  WHERE "isRead" = false;
