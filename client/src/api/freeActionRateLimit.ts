// src/api/freeActionRateLimit.ts
//
// Per-senderId rate limit on free actions (unlike, unfollow). These cost
// 0 CAW so an attacker could spam them to grief the validator's gas
// budget. Backed by Redis instead of an in-memory Map so the limit is
// shared across worker processes — the in-memory version was bypassable
// by spreading requests across workers (effective limit = N×30/min for
// N workers).

import Redis from 'ioredis'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const FREE_ACTION_LIMIT = Number(process.env.FREE_ACTION_LIMIT_PER_MIN) || 30
const WINDOW_SECONDS = 60

// unlike=2, unfollow=5 — these are the only action types that don't deduct CAW.
export const FREE_ACTION_CODES = new Set([2, 5])

const KEY = (senderId: number) => `caw:rate:free:${senderId}`

/**
 * Increment-and-check. Returns true if the action is allowed (under the
 * limit) and false if the sender has hit the cap for this minute. Fails
 * open on Redis unavailability — better to let actions through than to
 * lose them on a transient Redis blip; the validator's own batch logic
 * caps per-tx work regardless.
 */
export async function checkFreeActionRate(senderId: number, actionType: number): Promise<boolean> {
  if (!FREE_ACTION_CODES.has(actionType)) return true

  try {
    // INCR is atomic. We set the TTL on the first increment of the window
    // (TTL == -1 immediately after a fresh INCR sets the value to 1).
    const count = await redis.incr(KEY(senderId))
    if (count === 1) {
      // First write in this window — set the expiry. There's a small race
      // where two parallel INCRs both see count !== 1 and neither sets
      // expiry; mitigated by the ttl check below.
      await redis.expire(KEY(senderId), WINDOW_SECONDS)
    } else {
      // If the key has no expiry (shouldn't happen but covers the race
      // above plus Redis restarts that lose TTLs), set one. EXPIRE is
      // idempotent and cheap.
      const ttl = await redis.ttl(KEY(senderId))
      if (ttl < 0) await redis.expire(KEY(senderId), WINDOW_SECONDS)
    }
    return count <= FREE_ACTION_LIMIT
  } catch {
    // Redis unreachable — fail open. The alternative is a global outage
    // every time Redis hiccups.
    return true
  }
}
