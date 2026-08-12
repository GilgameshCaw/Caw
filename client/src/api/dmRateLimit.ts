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

// Inbound relay cap, per PROJECT_BACKLOG.md's DDoS protection section:
// "a peer hammering relayDmToPeers with spoofed identities can fill the
// DB." checkDmRate() above is sender-side and does warm/cold DB lookups
// (message/follow queries) — fine for a user hitting send, but wrong for
// the receiver side of /api/dm/relay: those lookups would themselves
// become a new load vector under a relay flood. This is deliberately
// dumber: one Redis INCR per (recipientId), no DB reads, no warm/cold
// distinction. It doesn't tell apart "one attacker" from "many senders
// legitimately messaging the same popular account" — same tradeoff the
// per-source-IP cap already makes, just on the other axis.
//
// 500/h, not 200/h as I first had it: sender-side warm senders alone can
// do 100/h each (WARM_LIMIT_PER_HOUR above), so a cap much lower than a
// small multiple of that would throttle a popular account getting
// legitimate messages from just a handful of warm contacts. 500 leaves
// headroom for that, in the loose sense — still not validated against
// real usage, just checked against the other limiter so they're not
// flatly contradictory.
//
// Correction (found in review of #48 by tentencaw): "room for ~5
// concurrent warm senders" overstated the precision of that comparison.
// KEY_WARM is scoped per-(senderId, recipientId) and only enforced by
// the sender's home node; KEY_INBOUND_RELAY is scoped per-recipientId
// and aggregates across every source instance relaying to them. Warm
// senders on other instances aren't counted against this node's
// WARM_LIMIT_PER_HOUR at all, so "5 senders at 100/h each" isn't a real
// derivation of 500 — just a rough sanity check that 500 isn't obviously
// too low relative to the other number in this file.
const INBOUND_RELAY_LIMIT_PER_HOUR = Number(process.env.DM_RELAY_INBOUND_LIMIT_PER_HOUR) || 500
const KEY_INBOUND_RELAY = (recipientId: number) => `caw:dm:rate:relay-inbound:${recipientId}`

/**
 * Increment-and-check the inbound relay bucket for a recipient. Fail-open
 * on Redis errors, matching checkDmRate()'s behavior — the per-source-IP
 * cap in server.ts is the backstop if this path is unavailable.
 */
/**
 * Read-only check — does NOT increment. Safe to call before the request
 * is authenticated: cheap (single Redis GET, no write), so it can't be
 * used to cheaply exhaust a target recipient's budget the way calling
 * checkInboundRelayRate() pre-auth could (found in review of #48 by
 * tentencaw — an attacker who never bothers signing correctly could
 * still burn through a victim's hourly budget with junk requests, since
 * the increment happened before signature verification rejected them).
 * Callers should peek before doing expensive work, then call
 * recordInboundRelayHit() only after the request is fully verified.
 */
export async function peekInboundRelayRate(recipientId: number): Promise<{ allowed: boolean; resetSeconds?: number }> {
  const key = KEY_INBOUND_RELAY(recipientId)
  try {
    const [count, ttl] = await Promise.all([
      redis.get(key),
      redis.ttl(key),
    ])
    const n = count ? Number(count) : 0
    if (n > INBOUND_RELAY_LIMIT_PER_HOUR) {
      return { allowed: false, resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS }
    }
    return { allowed: true }
  } catch (err: any) {
    // Fail-open, matching recordInboundRelayHit() and checkDmRate()
    // above. Logged (found lacking in review of #48 by tentencaw) so a
    // sustained Redis outage shows up somewhere other than "the limiter
    // silently stopped limiting" — this fires on every peek during an
    // outage, which is noisy, but the alternative (no signal at all)
    // is worse for noticing the limiter is effectively off.
    console.warn(`[DM Relay] peekInboundRelayRate failed open for recipient=${recipientId}: ${err?.message ?? err}`)
    return { allowed: true }
  }
}

/**
 * Increment-and-check the inbound relay bucket for a recipient. Call
 * only after the request has been fully authenticated — see
 * peekInboundRelayRate() above for why. ttl < 0 (not just count === 1)
 * re-arms the window on every call where the TTL is missing, so a prior
 * expire() failure (e.g. a Redis blip between the incr and the expire)
 * self-heals on the next hit instead of leaving the key permanently
 * unexpiring — same pattern checkDmRate() uses above. (Also found in
 * review of #48 by tentencaw.)
 */
export async function recordInboundRelayHit(recipientId: number): Promise<{ allowed: boolean; resetSeconds?: number }> {
  const key = KEY_INBOUND_RELAY(recipientId)
  try {
    const count = await redis.incr(key)
    const ttl = await redis.ttl(key)
    if (ttl < 0) {
      await redis.expire(key, WINDOW_SECONDS)
    }
    if (count > INBOUND_RELAY_LIMIT_PER_HOUR) {
      return { allowed: false, resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS }
    }
    return { allowed: true }
  } catch (err: any) {
    console.warn(`[DM Relay] recordInboundRelayHit failed open for recipient=${recipientId}: ${err?.message ?? err}`)
    return { allowed: true }
  }
}

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
