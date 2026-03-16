import Redis from 'ioredis'
import { randomBytes } from 'crypto'

const redis = new Redis({
  port: 6379,
  host: '127.0.0.1',
})

const KEY_PREFIX = 'caw:session:'
const SESSION_TTL = 2 * 365 * 24 * 60 * 60 // 2 years in seconds

export interface SessionData {
  authorizedTokenIds: number[]
  authorizedAddresses: string[] // lowercase
  createdAt: number
  expiresAt: number
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

  // Add tokenIds if not already present
  for (const id of tokenIds) {
    if (!session.authorizedTokenIds.includes(id)) {
      session.authorizedTokenIds.push(id)
    }
  }

  // Preserve remaining TTL
  const remainingTtl = await redis.ttl(KEY_PREFIX + token)
  if (remainingTtl > 0) {
    await redis.setex(KEY_PREFIX + token, remainingTtl, JSON.stringify(session))
  }

  return session
}

export async function isAuthorized(token: string, tokenId: number): Promise<boolean> {
  const session = await getSession(token)
  if (!session) return false
  return session.authorizedTokenIds.includes(tokenId)
}

export async function deleteSession(token: string): Promise<void> {
  await redis.del(KEY_PREFIX + token)
}
