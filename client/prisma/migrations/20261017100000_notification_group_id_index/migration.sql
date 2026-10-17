-- The notification list builds its avatar stack with a DISTINCT ON query that
-- filters Notification by "groupId". No index covered that column, so the
-- query read the whole table with a parallel sequential scan on every
-- notification list request for users with multi-member groups.
CREATE INDEX "Notification_groupId_idx" ON "Notification"("groupId");
