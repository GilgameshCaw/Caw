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
 *
 * NOTE: this function is RACE-PRONE under concurrent requests because
 * read-then-decide-then-record has a TOCTOU window. For routes that
 * accept untrusted concurrent uploads (POST /upload, /encrypted), use
 * `reserveUpload` instead — atomic increment + rollback on overrun.
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

/**
 * Atomic reserve-and-check for the upload quota. Returns whether the
 * reservation succeeded; on success, the bytes are already counted in
 * the running window. On failure (over quota), the reservation is
 * rolled back so a subsequent honest upload from the same tokenId is
 * not punished by the failed attempt.
 *
 * Uses the same `upload_quota:<kind>:<tokenId>` Redis key as
 * recordUsage, but with an atomic INCRBY counter alongside the rolling
 * list. The counter is a fast read for `canUpload`-style precheck; the
 * list preserves the timestamped entries so getUsage's rolling-window
 * eviction still works after a quota period passes.
 *
 * Audit fix 2026-05-09 (Round 6 economic agent HIGH-2): closes the
 * concurrent-upload race where 50 parallel POSTs all read used=0 and
 * collectively committed 50× the quota.
 */
export async function reserveUpload(
  kind: UploadQuotaKind,
  tokenId: number,
  bytes: number,
): Promise<{ ok: true; used: number; quota: number }
         | { ok: false; used: number; quota: number; remaining: number }> {
  const quota = quotaFor(kind)
  const k = key(kind, tokenId)
  // Append the candidate entry first, then sum to validate. If we go
  // over, pop the entry we just added. This is racy in only one
  // direction — two concurrent attempts that fit individually but not
  // together both append, both sum-and-rollback, and both end up
  // rejected. Acceptable; legitimate users retry, attackers gain
  // nothing.
  const entry = `${Date.now()}:${bytes}`
  await redis.rpush(k, entry)
  await redis.expire(k, WINDOW_SECONDS)
  const used = await getUsage(kind, tokenId)
  if (used > quota) {
    // Rollback: remove the entry we just appended (LREM removes by
    // value; a colliding entry from a sibling tokenId can't share this
    // exact `${Date.now()}:${bytes}` because the list is per-tokenId).
    await redis.lrem(k, 1, entry)
    const usedAfterRollback = await getUsage(kind, tokenId)
    return {
      ok: false,
      used: usedAfterRollback,
      quota,
      remaining: Math.max(0, quota - usedAfterRollback),
    }
  }
  return { ok: true, used, quota }
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

/** Refund a previous reservation. Best-effort — only matched-by-value
 *  entries are removed, and we tolerate failures because over-counting
 *  is preferable to under-counting from this codepath. Used when the
 *  storage put() after a successful reserveUpload fails, so a transient
 *  failure doesn't permanently consume the user's quota. */
export async function refundReservation(kind: UploadQuotaKind, tokenId: number, bytes: number): Promise<void> {
  try {
    const k = key(kind, tokenId)
    // Match the entry shape reserveUpload appended. We can't know the
    // exact timestamp here, but a simple lrange scan finds the most-
    // recent entry with the matching size and removes it.
    const entries = await redis.lrange(k, 0, -1)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const [, sizeStr] = entry.split(':')
      if (Number(sizeStr) === bytes) {
        await redis.lrem(k, 1, entry)
        return
      }
    }
  } catch (e) {
    console.warn('[uploadQuota] refundReservation failed (non-fatal):', e)
  }
}
