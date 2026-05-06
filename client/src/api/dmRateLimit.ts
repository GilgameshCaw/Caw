// src/api/dmRateLimit.ts
//
// Per-(senderId, recipientId) DM rate limiter, backed by Redis. The
// receiver-side coarse limit (per-source-IP, mounted in server.ts at
// /api/dm/relay) catches a misbehaving peer hammering us; this is the
// fine-grained per-user-pair limit applied on the SENDER's side, where
// the home node knows the user's session and can apply consent
// baseline. The receiver trusts that the source enforced this — a
// source that lies costs them their relay reputation, future work.
//
// Caps:
//   - cold (recipient has no consent baseline for sender): 10/h
//   - warm (recipient has DM'd back, or there's a follow either way): 100/h
//
// "Warm" reduces to "any prior message from recipient → sender", "sender
// follows recipient", or "recipient follows sender". These are the same
// signals the request-inbox gate uses, so the labels stay consistent.

import Redis from 'ioredis'
import { prisma } from '../prismaClient'

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const COLD_LIMIT_PER_HOUR = Number(process.env.DM_SEND_COLD_LIMIT_PER_HOUR) || 10
const WARM_LIMIT_PER_HOUR = Number(process.env.DM_SEND_WARM_LIMIT_PER_HOUR) || 100
const WINDOW_SECONDS = 60 * 60

const KEY_COLD = (senderId: number, recipientId: number) =>
  `caw:dm:rate:cold:${senderId}:${recipientId}`
const KEY_WARM = (senderId: number, recipientId: number) =>
  `caw:dm:rate:warm:${senderId}:${recipientId}`

export type DmRateCheck =
  | { allowed: true; limit: number; remaining: number; warm: boolean }
  | { allowed: false; limit: number; resetSeconds: number; warm: boolean }

/**
 * Compute warm vs cold for the (sender, recipient) pair. Reads three
 * cheap indexed lookups; cached on neither side because the consent
 * state changes (replies, follows, unfollows) and a stale cache would
 * misroute messages between Requests and Main inbox.
 */
async function isWarm(senderId: number, recipientId: number): Promise<boolean> {
  const [reply, senderFollows, recipientFollows] = await Promise.all([
    prisma.message.findFirst({
      where: {
        senderId: recipientId,
        conversation: { participants: { some: { userId: senderId } } },
      },
      select: { id: true },
    }),
    prisma.follow.findFirst({
      where: { followerId: senderId, followingId: recipientId, action: 'FOLLOW' },
      select: { id: true },
    }),
    prisma.follow.findFirst({
      where: { followerId: recipientId, followingId: senderId, action: 'FOLLOW' },
      select: { id: true },
    }),
  ])
  return !!(reply || senderFollows || recipientFollows)
}

/**
 * Increment-and-check the appropriate bucket. Returns whether the send
 * is allowed and how much budget is left. Caller emits 429 + Retry-After
 * on `allowed: false`.
 */
export async function checkDmRate(senderId: number, recipientId: number): Promise<DmRateCheck> {
  const warm = await isWarm(senderId, recipientId)
  const limit = warm ? WARM_LIMIT_PER_HOUR : COLD_LIMIT_PER_HOUR
  const key = warm ? KEY_WARM(senderId, recipientId) : KEY_COLD(senderId, recipientId)

  // Atomic incr + ttl-on-first-write. The pipeline is fine because we
  // don't care about a microsecond race that lets two requests race to
  // increment past the limit by 1 — the bucket resets in an hour either
  // way.
  const pipeline = redis.pipeline()
  pipeline.incr(key)
  pipeline.ttl(key)
  const results = await pipeline.exec()
  if (!results) {
    // Redis unreachable — fail open. Better to let messages through
    // than to lose them entirely on Redis flakiness; the per-source-IP
    // cap on the receiver side still applies.
    return { allowed: true, limit, remaining: limit - 1, warm }
  }
  const count = Number(results[0][1] as number)
  const ttl = Number(results[1][1] as number)

  if (ttl < 0) {
    // First insert (TTL not yet set) or expired key — set the window.
    await redis.expire(key, WINDOW_SECONDS)
  }

  if (count > limit) {
    const reset = ttl > 0 ? ttl : WINDOW_SECONDS
    return { allowed: false, limit, resetSeconds: reset, warm }
  }
  return { allowed: true, limit, remaining: limit - count, warm }
}
