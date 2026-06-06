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

import { promises as fs } from 'fs'
import path from 'path'
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

const CURSOR_PATH = './state/cawai-cursor.json'
const REPLIED_PATH = './state/cawai-replied.json'
const MAX_REPLIED_ENTRIES = 1000

export async function loadCursor(): Promise<Cursor> {
  try {
    const raw = await fs.readFile(CURSOR_PATH, 'utf8')
    return JSON.parse(raw) as Cursor
  } catch {
    return { lastSeenNotificationId: 0 }
  }
}

export async function saveCursor(cursor: Cursor): Promise<void> {
  await fs.mkdir(path.dirname(CURSOR_PATH), { recursive: true }).catch(() => {})
  await fs.writeFile(CURSOR_PATH, JSON.stringify(cursor))
}

async function loadReplied(): Promise<Set<number>> {
  try {
    const raw = await fs.readFile(REPLIED_PATH, 'utf8')
    const arr = JSON.parse(raw) as number[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

async function saveReplied(ids: Set<number>): Promise<void> {
  await fs.mkdir(path.dirname(REPLIED_PATH), { recursive: true }).catch(() => {})
  // FIFO trim to MAX_REPLIED_ENTRIES
  let arr = Array.from(ids)
  if (arr.length > MAX_REPLIED_ENTRIES) arr = arr.slice(arr.length - MAX_REPLIED_ENTRIES)
  await fs.writeFile(REPLIED_PATH, JSON.stringify(arr))
}

export async function fetchNewMentions(
  cfg: CawAIConfig,
  cursor: Cursor,
): Promise<{ mentions: PendingMention[]; newCursor: Cursor }> {
  // GET /api/notifications?userId=<botTokenId>&type=MENTION
  // Notifications are returned most-recent-first. We filter to id >
  // cursor.lastSeenNotificationId, then reverse so we process oldest
  // first. Per-notification shape: { id, type, actor, caw, createdAt }
  const url = `${cfg.apiUrl}/api/notifications?userId=${cfg.profileTokenId}&type=MENTION&limit=50`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`notifications fetch ${resp.status}`)
  const body = await resp.json() as {
    notifications: Array<{
      id: number
      type: string
      actor: { tokenId: number; username: string } | null
      caw: { id: number; content: string } | null
      createdAt: string
    }>
  }

  const replied = await loadReplied()

  // Filter: only rows newer than cursor, not already replied to.
  const fresh = body.notifications
    .filter(n => n.id > cursor.lastSeenNotificationId && !replied.has(n.id))
    .reverse() // oldest first so we process in chronological order

  const mentions: PendingMention[] = []
  for (const n of fresh) {
    if (!n.actor || !n.caw) {
      // Notification is missing actor or caw context — skip but still
      // advance cursor so we don't retry it every poll.
      continue
    }

    let cawText = n.caw.content
    let authorUsername = n.actor.username
    const authorTokenId = n.actor.tokenId
    const cawId = n.caw.id

    // If the notification's caw content field is empty (can happen if
    // the caw is still PENDING at notification-creation time), do a
    // follow-up GET /api/caws/:id to hydrate it.
    if (!cawText) {
      try {
        const cawResp = await fetch(`${cfg.apiUrl}/api/caws/${cawId}`)
        if (cawResp.ok) {
          const cawData = await cawResp.json() as {
            content?: string
            user?: { username?: string }
          }
          cawText = cawData.content ?? ''
          if (cawData.user?.username) authorUsername = cawData.user.username
        }
      } catch {
        // best-effort; proceed with empty text
      }
    }

    mentions.push({
      notificationId: n.id,
      cawId,
      cawText,
      authorTokenId,
      authorUsername,
      createdAt: n.createdAt,
    })
  }

  // New cursor = highest id we saw (whether or not we acted on it)
  const allIds = body.notifications.map(n => n.id)
  const maxId = allIds.length > 0 ? Math.max(...allIds) : cursor.lastSeenNotificationId
  const newCursor: Cursor = { lastSeenNotificationId: Math.max(cursor.lastSeenNotificationId, maxId) }

  await saveCursor(newCursor)

  return { mentions, newCursor }
}

export async function markReplied(
  _cfg: CawAIConfig,
  notificationIds: number[],
): Promise<void> {
  // Append to the local replied set. Crash-safe: the replied set is the
  // canonical source of "did we already respond?" so a restart after a
  // crash doesn't double-reply.
  const replied = await loadReplied()
  for (const id of notificationIds) replied.add(id)
  await saveReplied(replied)
}
