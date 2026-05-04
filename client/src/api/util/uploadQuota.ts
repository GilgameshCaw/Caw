// Per-token daily upload quota, scoped by upload kind. Counts cumulative
// bytes uploaded per tokenId per rolling 24h window. Posts and DMs are
// SEPARATE budgets — a heavy DM user can't starve their post quota and
// vice versa. DMs have a much tighter cap because they reach 1 person
// (1:1 channel) vs posts reaching the world; per-byte storage cost is
// the same, but the value-per-byte is wildly different.
//
// Why per-token (not per-IP / per-address): tokens map cleanly to users
// in this app, the auth layer already validates token ownership before
// reaching upload routes, and per-IP doesn't work behind shared NAT.
//
// Why bytes (not request count): a 10MB video and a 100KB image have
// wildly different storage cost. Counting bytes is the right unit.
//
// Storage shape mirrors session_ratelimit (Redis list of timestamp:size
// entries) because (a) it's the established pattern in this codebase,
// (b) it survives restarts, (c) checking the running total is O(N) over
// today's entries which stays small at sane caps.

import Redis from 'ioredis'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const WINDOW_SECONDS = 24 * 60 * 60

export type UploadQuotaKind = 'post' | 'dm'

// Posts: 200MB/day. At 10MB max per video that's ~20 videos/day;
// at 1MB per image, 200 images/day. A normal user is nowhere near.
// A bot in a tight loop hits this in seconds and gets cut off.
const POST_QUOTA_BYTES = 200 * 1024 * 1024
// DMs: 30MB/day. ~15 of the 2MB cleartext DM videos, or ~40 DM images.
// Tighter than posts because DMs reach 1 person — value-per-byte to the
// network is much lower, so the storage cost ceiling should be too.
const DM_QUOTA_BYTES = 30 * 1024 * 1024

export function quotaFor(kind: UploadQuotaKind): number {
  return kind === 'dm' ? DM_QUOTA_BYTES : POST_QUOTA_BYTES
}

function key(kind: UploadQuotaKind, tokenId: number): string {
  return `upload_quota:${kind}:${tokenId}`
}

/** Total bytes uploaded by tokenId for the given kind in the rolling
 *  24h window. */
export async function getUsage(kind: UploadQuotaKind, tokenId: number): Promise<number> {
  const entries = await redis.lrange(key(kind, tokenId), 0, -1)
  const cutoff = Date.now() - WINDOW_SECONDS * 1000
  let total = 0
  for (const entry of entries) {
    const [tsStr, sizeStr] = entry.split(':')
    const ts = Number(tsStr)
    if (Number.isFinite(ts) && ts >= cutoff) {
      total += Number(sizeStr) || 0
    }
  }
  return total
}

/**
 * Returns true if {tokenId} can upload {bytes} more under their {kind}
 * budget without exceeding it. Pure check — call recordUsage() after a
 * successful upload to commit the bytes against their quota. The check-
 * then-record split lets the route reject before doing the upload.
 */
export async function canUpload(
  kind: UploadQuotaKind,
  tokenId: number,
  bytes: number,
): Promise<{ allowed: boolean; used: number; remaining: number; quota: number }> {
  const quota = quotaFor(kind)
  const used = await getUsage(kind, tokenId)
  const remaining = Math.max(0, quota - used)
  return { allowed: used + bytes <= quota, used, remaining, quota }
}

/** Append a usage entry. Best-effort — we don't bubble Redis errors back
 *  to the upload caller because losing a quota record is recoverable
 *  (the entry just isn't counted) and we'd rather complete the upload
 *  than fail it on a transient Redis blip. */
export async function recordUsage(kind: UploadQuotaKind, tokenId: number, bytes: number): Promise<void> {
  try {
    const k = key(kind, tokenId)
    await redis.rpush(k, `${Date.now()}:${bytes}`)
    await redis.expire(k, WINDOW_SECONDS)
    // Trim entries older than the window. LREM by value isn't the right
    // shape here (we don't know exact timestamps); instead we let the
    // list grow until expire() resets it daily. With 24h of entries at
    // ~20 uploads/user/day, the list stays tiny.
  } catch (e) {
    console.warn('[uploadQuota] recordUsage failed (non-fatal):', e)
  }
}
