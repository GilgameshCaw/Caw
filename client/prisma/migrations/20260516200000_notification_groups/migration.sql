-- Persistent rollup buckets for notifications. Replaces the
-- read-time GROUP BY aggregation with a write-time bucket assignment.
-- Read path becomes O(group page size) instead of O(raw notifications).

CREATE TABLE IF NOT EXISTS "NotificationGroup" (
  "id"                   SERIAL PRIMARY KEY,
  "userId"               INTEGER NOT NULL,
  "type"                 "NotificationType" NOT NULL,
  "targetKey"            TEXT,
  "openedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEventAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isRead"               BOOLEAN NOT NULL DEFAULT false,
  "latestNotificationId" INTEGER NOT NULL,
  "count"                INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "NotificationGroup_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE
);

-- Read-feed index: paginate a user's groups by recency.
CREATE INDEX IF NOT EXISTS "NotificationGroup_userId_lastEventAt_idx"
  ON "NotificationGroup" ("userId", "lastEventAt" DESC);

-- Open-group lookup index: write path checks for an existing open
-- group on (userId, type, targetKey) with isRead=false and
-- lastEventAt within the 15-minute window.
CREATE INDEX IF NOT EXISTS "NotificationGroup_userId_type_targetKey_isRead_lastEventAt_idx"
  ON "NotificationGroup" ("userId", "type", "targetKey", "isRead", "lastEventAt");

-- Add the back-reference column to Notification. Nullable so existing
-- rows survive the migration; backfilled below.
ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "groupId" INTEGER;

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "NotificationGroup"("id")
  ON DELETE SET NULL;

-- Backfill: collapse existing notifications into groups using the same
-- semantics the runtime would use — (userId, type, targetKey) buckets
-- with the 15-minute open window. We approximate by greedily walking
-- existing rows in createdAt order, opening a new group whenever the
-- gap from the previous same-bucket row exceeds 15 minutes.
--
-- targetKey derivation mirrors the runtime helper:
--   FOLLOW                              → NULL
--   OFFER                               → "offerId"
--   anything with cawId (LIKE, REPLY, REPOST, QUOTE, TIP, MENTION) → "cawId"
--   ACTION_FAILED                       → NULL (each its own row)
--
-- Pre-existing groupKey column on Notification is ignored — the new
-- (userId, type, targetKey) shape is the authoritative bucket key.

DO $$
DECLARE
  notif RECORD;
  prev_group_id INTEGER;
  prev_user INTEGER;
  prev_type "NotificationType";
  prev_target TEXT;
  prev_event TIMESTAMP(3);
  prev_isread BOOLEAN;
  open_window INTERVAL := INTERVAL '15 minutes';
  -- Per-bucket cursors so we open a fresh group when the bucket key
  -- changes OR when the gap exceeds the open window OR when the prior
  -- group was already read.
  bucket_key TEXT;
  this_target TEXT;
  prev_bucket TEXT;
  same_bucket BOOLEAN;
  new_group_id INTEGER;
BEGIN
  -- Use a separate temp table to hold the per-(user, type, target)
  -- "current open group" pointer as we walk. PL/pgSQL doesn't have a
  -- nice expression for this otherwise.
  CREATE TEMP TABLE IF NOT EXISTS _open_groups (
    bucket TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL,
    last_event TIMESTAMP(3) NOT NULL,
    is_read BOOLEAN NOT NULL
  ) ON COMMIT DROP;

  FOR notif IN
    SELECT n."id", n."userId", n."type"::TEXT AS type_text, n."type" AS type_val,
           n."cawId", n."offerId", n."isRead", n."hidden", n."createdAt"
    FROM "Notification" n
    WHERE n."groupId" IS NULL
    ORDER BY n."userId", n."type", n."createdAt", n."id"
  LOOP
    -- Derive targetKey for this row.
    IF notif.type_text = 'FOLLOW' OR notif.type_text = 'ACTION_FAILED' THEN
      this_target := NULL;
    ELSIF notif.type_text = 'OFFER' THEN
      this_target := notif."offerId"::TEXT;
    ELSE
      this_target := notif."cawId"::TEXT;
    END IF;

    bucket_key := notif."userId" || '|' || notif.type_text || '|' || COALESCE(this_target, '');

    -- Try to reuse an open group for this bucket.
    SELECT group_id, last_event, is_read
      INTO prev_group_id, prev_event, prev_isread
      FROM _open_groups WHERE bucket = bucket_key;

    IF prev_group_id IS NOT NULL
       AND prev_isread = false
       AND notif."createdAt" - prev_event <= open_window THEN
      -- Join existing open group.
      UPDATE "NotificationGroup"
        SET "count" = "count" + 1,
            "lastEventAt" = notif."createdAt",
            "latestNotificationId" = notif."id"
        WHERE id = prev_group_id;
      UPDATE "Notification" SET "groupId" = prev_group_id WHERE id = notif."id";
      UPDATE _open_groups SET last_event = notif."createdAt", is_read = notif."isRead" WHERE bucket = bucket_key;
    ELSE
      -- Open a fresh group.
      INSERT INTO "NotificationGroup" (
        "userId", "type", "targetKey", "openedAt", "lastEventAt",
        "isRead", "latestNotificationId", "count"
      ) VALUES (
        notif."userId", notif.type_val, this_target, notif."createdAt", notif."createdAt",
        notif."isRead", notif."id", 1
      ) RETURNING id INTO new_group_id;
      UPDATE "Notification" SET "groupId" = new_group_id WHERE id = notif."id";
      INSERT INTO _open_groups (bucket, group_id, last_event, is_read)
        VALUES (bucket_key, new_group_id, notif."createdAt", notif."isRead")
        ON CONFLICT (bucket) DO UPDATE
          SET group_id = EXCLUDED.group_id,
              last_event = EXCLUDED.last_event,
              is_read = EXCLUDED.is_read;
    END IF;
  END LOOP;

  -- Reconcile each group's isRead flag: read iff ALL members are read.
  -- The backfill above kept "any-unread sticks" semantics via the
  -- _open_groups.is_read flag, but a group whose member rows all
  -- became read post-event should be marked read so the UI matches
  -- the runtime invariant.
  UPDATE "NotificationGroup" g
    SET "isRead" = NOT EXISTS (
      SELECT 1 FROM "Notification" n
      WHERE n."groupId" = g.id AND n."isRead" = false
    );
END $$;
