// CawAI/mentionWatcher.ts
//
// Polls the configured mirror's /api/notifications endpoint for new
// MENTION rows addressed to the bot's profileTokenId, returning the
// ones we haven't replied to yet.
//
// The notification-tip-gate (see commit ab7135ab) already filters at
// the indexer layer: if the operator sets the bot's
// notificationTipRequired > 0 via PATCH /api/users/:tokenId/notification-tip-gate,
// mentions without sufficient embedded tip never even produce a
// Notification row, so this watcher never sees them. That's the
// load-bearing economic spam defense — the watcher itself trusts the
// /api/notifications cursor.
//
// Mention syntax recognized (per NotificationService.extractMentions,
// which uses /@(\w+)/ — \w matches both letters and digits):
//   - @username      e.g. @gilgatwo
//   - @tokenId       e.g. @7
// Both produce a Notification row routed to the resolved tokenId. The
// bot doesn't need to do any extra parsing — if /api/notifications has
// it for our tokenId, it's a valid mention to act on.

import type { CawAIConfig } from './config'

export type PendingMention = {
  notificationId: number
  cawId: number
  cawText: string
  authorTokenId: number
  authorUsername: string
  createdAt: string
}

export type Cursor = {
  lastSeenNotificationId: number
}

export async function fetchNewMentions(
  cfg: CawAIConfig,
  cursor: Cursor,
): Promise<{ mentions: PendingMention[]; newCursor: Cursor }> {
  // TODO: hit GET /api/notifications?userId=<bot>&type=MENTION&since=<cursor>
  // Returns rows sorted by id desc; flip + filter to id > cursor.lastSeenNotificationId.
  // Per-mention shape pulled in along with the originating Caw text +
  // author handle so we don't need a second round-trip.
  void cfg; void cursor
  return { mentions: [], newCursor: cursor }
}

export async function markReplied(
  cfg: CawAIConfig,
  notificationIds: number[],
): Promise<void> {
  // Local-only state. The bot persists its cursor + per-notification
  // "replied" set to disk (Lambda: /tmp; VPS: ./state/cawai-state.json)
  // so a crash mid-batch doesn't double-reply.
  void cfg; void notificationIds
}
