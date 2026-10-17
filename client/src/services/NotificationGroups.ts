/**
 * Dismiss the groups that the given notifications belong to.
 *
 * The feed shows one row per group and the × / Retry-success paths send
 * that row's id, i.e. the group's latest member. Hiding only that member
 * left the group in the feed (the list never filtered on `hidden`), and
 * an open group kept collecting new events on top of the dismissed ones.
 * So: close the group (the next event opens a fresh one) and hide + read
 * every member. Rows from before the group table (groupId null) are
 * hidden on their own.
 *
 * Returns the ids from `notificationIds` that belong to `userId`.
 */
export async function hideNotificationGroups(
  client: { notification: any; notificationGroup: any },
  userId: number,
  notificationIds: number[],
): Promise<number[]> {
  const rows: Array<{ id: number; groupId: number | null }> = await client.notification.findMany({
    where: { id: { in: notificationIds }, userId },
    select: { id: true, groupId: true },
  })
  if (rows.length === 0) return []

  const groupIds = Array.from(new Set(rows.map(r => r.groupId).filter((x): x is number => x != null)))
  if (groupIds.length > 0) {
    await client.notificationGroup.updateMany({
      where: { id: { in: groupIds }, userId },
      data: { isRead: true },
    })
    await client.notification.updateMany({
      where: { groupId: { in: groupIds }, userId },
      data: { hidden: true, isRead: true },
    })
  }
  const ungrouped = rows.filter(r => r.groupId == null).map(r => r.id)
  if (ungrouped.length > 0) {
    await client.notification.updateMany({
      where: { id: { in: ungrouped }, userId },
      data: { hidden: true },
    })
  }
  return rows.map(r => r.id)
}
