import Redis from 'ioredis'
import { randomBytes, createHash } from 'crypto'

// Honor REDIS_URL when set so multi-install setups can isolate Redis
// state into different logical databases (redis://host:port/N). Falls
// back to the legacy hardcoded localhost:6379 default.
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

const KEY_PREFIX = 'caw:session:'
// Reverse index: caw:tokenAuth:<tokenId> is a Redis Set of session tokens
// that have authorized this tokenId. Lets pruneTokenIdFromAllSessions()
// touch only the affected sessions on a transfer instead of SCAN'ing the
// whole session keyspace. Mirrors session TTL so dead entries fall off
// naturally.
const TOKEN_AUTH_PREFIX = 'caw:tokenAuth:'
const SESSION_TTL = 365 * 24 * 60 * 60 // 1 year in seconds

// One-time-use dedup for auth signatures. The signed auth message has a
// 5-minute freshness window — without consumption, an attacker who captures
// the signed message can replay it repeatedly within that window to attach
// the victim's wallet to attacker-controlled sessions. The consumed flag
// is keyed by the SHA-256 of the (message, signature) pair so malleated
// signatures over the same message still collapse to the same flag.
//
// TTL = MAX_MESSAGE_AGE_MS (5 minutes). After that the message's own
// timestamp-freshness check rejects it regardless. Audit fix 2026-05-13.
const AUTH_SIG_PREFIX = 'caw:authSig:'
const AUTH_SIG_TTL_SECONDS = 5 * 60

export interface SessionData {
  authorizedTokenIds: number[]
  authorizedAddresses: string[] // lowercase
  createdAt: number
  expiresAt: number
}

/**
 * Atomically mark an auth signature as consumed. Returns true if the
 * signature was fresh (caller may proceed), false if it had already been
 * used. Uses Redis SET ... NX EX for atomicity — no race between two
 * parallel verify calls with the same (message, signature).
 *
 * Caller passes the canonical SHA-256 of `message || signature`; we
 * compute it here so the routes don't need to know the key format.
 */
export async function consumeAuthSignatureOnce(message: string, signature: string): Promise<boolean> {
  const digest = createHash('sha256').update(message).update(signature).digest('hex')
  const key = AUTH_SIG_PREFIX + digest
  // SET NX = only set if not exists; EX = with TTL.
  const result = await redis.set(key, '1', 'EX', AUTH_SIG_TTL_SECONDS, 'NX')
  return result === 'OK'
}

export async function createSession(): Promise<{ token: string; session: SessionData }> {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  const session: SessionData = {
    authorizedTokenIds: [],
    authorizedAddresses: [],
    createdAt: now,
    expiresAt: now + SESSION_TTL * 1000,
  }
  await redis.setex(KEY_PREFIX + token, SESSION_TTL, JSON.stringify(session))
  return { token, session }
}

export async function getSession(token: string): Promise<SessionData | null> {
  const raw = await redis.get(KEY_PREFIX + token)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionData
  } catch {
    return null
  }
}

export async function addAuthorization(
  token: string,
  address: string,
  tokenIds: number[]
): Promise<SessionData | null> {
  const session = await getSession(token)
  if (!session) return null

  const normalizedAddress = address.toLowerCase()

  // Add address if not already present
  if (!session.authorizedAddresses.includes(normalizedAddress)) {
    session.authorizedAddresses.push(normalizedAddress)
  }

  // Add tokenIds if not already present, and update the reverse index so
  // pruneTokenIdFromAllSessions can find this session on a future
  // transfer. Pipeline the SADDs to keep the write count low.
  const newlyAdded: number[] = []
  for (const id of tokenIds) {
    if (!session.authorizedTokenIds.includes(id)) {
      session.authorizedTokenIds.push(id)
      newlyAdded.push(id)
    }
  }
  if (newlyAdded.length > 0) {
    const pipeline = redis.pipeline()
    for (const id of newlyAdded) {
      pipeline.sadd(TOKEN_AUTH_PREFIX + id, token)
      pipeline.expire(TOKEN_AUTH_PREFIX + id, SESSION_TTL)
    }
    await pipeline.exec()
  }

  // Preserve remaining TTL
  const remainingTtl = await redis.ttl(KEY_PREFIX + token)
  if (remainingTtl > 0) {
    await redis.setex(KEY_PREFIX + token, remainingTtl, JSON.stringify(session))
  }

  return session
}

/**
 * Remove `tokenId` from authorizedTokenIds across every session that had it.
 * Called by NftTransferWatcher on every L1 Transfer event so the previous
 * owner can no longer act on the transferred profile via stale session
 * authorization. Uses the caw:tokenAuth:<tokenId> reverse index so we
 * touch only the relevant sessions, not the entire session keyspace.
 *
 * Idempotent: rerunning is harmless. Returns the number of sessions
 * affected for logging.
 */
export async function pruneTokenIdFromAllSessions(tokenId: number): Promise<number> {
  const indexKey = TOKEN_AUTH_PREFIX + tokenId
  const sessionTokens = await redis.smembers(indexKey)
  if (sessionTokens.length === 0) return 0

  let pruned = 0
  for (const token of sessionTokens) {
    const session = await getSession(token)
    if (!session) {
      // Session expired between index write and now — drop from index.
      await redis.srem(indexKey, token)
      continue
    }
    const before = session.authorizedTokenIds.length
    session.authorizedTokenIds = session.authorizedTokenIds.filter(id => id !== tokenId)
    if (session.authorizedTokenIds.length === before) {
      // Already absent — index was stale. Tidy it.
      await redis.srem(indexKey, token)
      continue
    }
    const remainingTtl = await redis.ttl(KEY_PREFIX + token)
    if (remainingTtl > 0) {
      await redis.setex(KEY_PREFIX + token, remainingTtl, JSON.stringify(session))
    }
    await redis.srem(indexKey, token)
    pruned++
  }
  // Index might still have phantom entries if writes raced; let TTL clean.
  return pruned
}

export async function isAuthorized(token: string, tokenId: number): Promise<boolean> {
  const session = await getSession(token)
  if (!session) return false
  return session.authorizedTokenIds.includes(tokenId)
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(KEY_PREFIX + token)
}
