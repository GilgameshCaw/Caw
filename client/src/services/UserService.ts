import { prisma } from '../prismaClient'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../abi/addresses'
import { Contract, WebSocketProvider, JsonRpcProvider } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL1HttpRpcUrl, getL1WsRpcUrl, getL2WsRpcUrl, getL1WsSecret, getL2WsSecret } from '../utils/rpcProvider'

/** Thrown when a token ID doesn't exist on the current L1 contract (old deployment) */
export class StaleTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleTokenError'
  }
}

const CawProfileL2Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getTokens(uint32[] tokenIds) view returns (tuple(uint256 tokenId, uint256 balance, string username, uint256 cawBalance, uint256 nextCawonce)[])'
]

const CawProfileL1Abi = [
  'function usernames(uint256 index) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  // L1 CawProfile is ERC721Enumerable — lets us go from wallet → tokens owned
  // in O(tokensOwned) RPC calls instead of scanning every user row in the DB.
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)'
]

// Lazy-initialized providers - only created when first needed
let l2Provider: WebSocketProvider | null = null
let l2NameContract: Contract | null = null
let l1Provider: WebSocketProvider | null = null
let l1NameContract: Contract | null = null

// Rate limit tracking
let l2RetryDelay = 1000 // Start with 1 second
let l1RetryDelay = 1000
let l2LastAttempt = 0
let l1LastAttempt = 0
const MAX_RETRY_DELAY = 60000 // Max 60 seconds between retries

// Helper to create WebSocket provider with error handling
async function createWebSocketProvider(rpcUrl: string, name: string, secret?: string): Promise<WebSocketProvider> {
  return new Promise((resolve, reject) => {
    let provider: WebSocketProvider | null = null
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`${name} connection timeout`))
      }
    }, 30000)

    try {
      provider = makeWebSocketProvider(rpcUrl, 11155111, secret)

      // Handle connection errors via websocket
      const ws = (provider as any)._websocket || (provider as any).websocket
      if (ws && typeof ws.on === 'function') {
        ws.on('error', (error: any) => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(error)
          }
        })
      }

      // Wait for ready - in ethers v6, ready is a Promise in the default case
      // but a boolean `true` when staticNetwork is set (no network detection needed).
      const readyPromise: any = provider.ready
      if (readyPromise && typeof readyPromise.then === 'function') {
        readyPromise.then(() => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            resolve(provider!)
          }
        }).catch((error: any) => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(error)
          }
        })
      } else {
        // Fallback - just resolve after a short delay
        setTimeout(() => {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            resolve(provider!)
          }
        }, 2000)
      }
    } catch (error) {
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
  })
}

async function getL2Provider() {
  if (!l2Provider) {
    const rpcUrl = getL2WsRpcUrl()
    if (!rpcUrl) {
      throw new Error('Missing L2_RPC_URL in environment variables')
    }

    // Check if we need to wait due to rate limiting
    const now = Date.now()
    const timeSinceLastAttempt = now - l2LastAttempt
    if (l2LastAttempt > 0 && timeSinceLastAttempt < l2RetryDelay) {
      const waitTime = l2RetryDelay - timeSinceLastAttempt
      console.log(`[UserService] Rate limited, waiting ${waitTime}ms before L2 connection...`)
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    l2LastAttempt = Date.now()
    console.log('[UserService] Initializing L2 WebSocket provider...')

    try {
      l2Provider = await createWebSocketProvider(rpcUrl, 'L2', getL2WsSecret())
      l2NameContract = new Contract(
        CAW_NAMES_L2_ADDRESS,
        CawProfileL2Abi,
        l2Provider
      )
      // Reset retry delay on success
      l2RetryDelay = 1000
      console.log('[UserService] L2 WebSocket provider connected')
    } catch (error: any) {
      l2Provider = null
      const errorMsg = error.message || String(error)
      if (errorMsg.includes('429') || errorMsg.includes('rate') || errorMsg.includes('Unexpected server response')) {
        l2RetryDelay = Math.min(l2RetryDelay * 2, MAX_RETRY_DELAY)
        console.log(`[UserService] L2 rate limited, next retry in ${l2RetryDelay}ms`)
      }
      throw error
    }
  }
  return { provider: l2Provider, contract: l2NameContract! }
}

async function getL1Provider() {
  if (!l1Provider) {
    const rpcUrl = getL1WsRpcUrl()
    if (!rpcUrl) {
      throw new Error('Missing L1_RPC_URL in environment variables')
    }

    // Check if we need to wait due to rate limiting
    const now = Date.now()
    const timeSinceLastAttempt = now - l1LastAttempt
    if (l1LastAttempt > 0 && timeSinceLastAttempt < l1RetryDelay) {
      const waitTime = l1RetryDelay - timeSinceLastAttempt
      console.log(`[UserService] Rate limited, waiting ${waitTime}ms before L1 connection...`)
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    l1LastAttempt = Date.now()
    console.log('[UserService] Initializing L1 WebSocket provider...')

    try {
      l1Provider = await createWebSocketProvider(rpcUrl, 'L1', getL1WsSecret())
      l1NameContract = new Contract(
        CAW_NAMES_ADDRESS,
        CawProfileL1Abi,
        l1Provider
      )
      // Reset retry delay on success
      l1RetryDelay = 1000
      console.log('[UserService] L1 WebSocket provider connected')
    } catch (error: any) {
      l1Provider = null
      const errorMsg = error.message || String(error)
      if (errorMsg.includes('429') || errorMsg.includes('rate') || errorMsg.includes('Unexpected server response')) {
        l1RetryDelay = Math.min(l1RetryDelay * 2, MAX_RETRY_DELAY)
        console.log(`[UserService] L1 rate limited, next retry in ${l1RetryDelay}ms`)
      }
      throw error
    }
  }
  return { provider: l1Provider, contract: l1NameContract! }
}

// In-memory cache for findOrCreateUser so a batch of N actions from the same
// sender doesn't hit Postgres N times. A 32-caw thread previously caused 32
// parallel `user.findUnique` calls plus 32 parallel `$transaction` opens,
// serializing on row locks long enough to blow past Prisma's 5s interactive
// timeout. One shared in-flight Promise per tokenId collapses that to 1 DB hit.
//
// TTL is short: users can be renamed off-chain (profile updates) or have their
// on-chain owner transfer. 30s is long enough to absorb a burst and short
// enough that stale data can't linger across meaningful state changes.
type UserCacheEntry = { tokenId: number; promise: Promise<number>; expiresAt: number }
const USER_CACHE_TTL_MS = 30_000
const userCache = new Map<number, UserCacheEntry>()

function getCachedUser(tokenId: number): Promise<number> | undefined {
  const entry = userCache.get(tokenId)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    userCache.delete(tokenId)
    return undefined
  }
  return entry.promise
}

/**
 * findOrCreateUser
 * - uses on‑chain senderId as both L2 address and NFT tokenId
 */
export async function findOrCreateUser(
  senderId: number,
  opts: { onboardingStep?: number } = {},
): Promise<number> {
  const tokenId = senderId;
  if (tokenId === 0) {
    throw new Error("senderId cannot be zero");
  }

  // Skip cache when caller has onboarding semantics (fresh mint flow needs a
  // fresh write, not a shared promise from a prior request).
  if (!opts.onboardingStep) {
    const cached = getCachedUser(tokenId)
    if (cached) return cached
  }

  const promise = doFindOrCreateUser(tokenId, opts).catch(err => {
    // On failure, drop the cached rejection immediately so retries can
    // proceed — otherwise a transient L1 blip would poison the cache for 30s.
    userCache.delete(tokenId)
    throw err
  })

  if (!opts.onboardingStep) {
    userCache.set(tokenId, {
      tokenId,
      promise,
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    })
  }
  return promise
}

async function doFindOrCreateUser(
  tokenId: number,
  opts: { onboardingStep?: number },
): Promise<number> {
  let user = await prisma.user.findUnique({
    where: { tokenId }
  })

  if (!user) {
    // Get providers lazily - only created when needed (with rate limit handling)
    const { contract: l1Contract } = await getL1Provider()

    // Query L1 for owner address and username (L1 is authoritative — L2 may not have the token yet)
    const queryStart = Date.now()
    let ownerAddress: string
    let username: string

    // Helper: race a promise against a timeout
    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
      ])

    try {
      [ownerAddress, username] = await withTimeout(
        Promise.all([
          l1Contract.ownerOf(tokenId),
          l1Contract.usernames(tokenId - 1) // usernames array is 0-indexed, tokenIds start at 1
        ]),
        15000,
        'L1 query'
      );
    } catch (err: any) {
      // Token doesn't exist on current contract — likely a stale event from an old deployment
      if (err?.reason?.includes('invalid token ID') || err?.code === 'CALL_EXCEPTION') {
        const msg = `Token ${tokenId} does not exist on L1 contract (stale event from old deployment)`
        console.warn(`[UserService] ${msg} — skipping`)
        throw new StaleTokenError(msg)
      }

      // If WebSocket timed out, try HTTP fallback
      if (err?.message?.includes('timed out')) {
        console.warn(`[UserService] WebSocket timed out, trying HTTP fallback...`)
        const httpUrl = getL1HttpRpcUrl()
        if (httpUrl) {
          const httpProvider = makeJsonRpcProvider(httpUrl, 11155111)
          const httpContract = new Contract(CAW_NAMES_ADDRESS, CawProfileL1Abi, httpProvider)
          try {
            ;[ownerAddress, username] = await withTimeout(
              Promise.all([
                httpContract.ownerOf(tokenId),
                httpContract.usernames(tokenId - 1)
              ]),
              15000,
              'L1 HTTP fallback'
            )
            // Reset WSS provider so it reconnects next time
            l1Provider = null
            l1NameContract = null
            console.log(`[UserService] HTTP fallback succeeded in ${Date.now() - queryStart}ms`)
          } catch (fallbackErr: any) {
            if (fallbackErr?.reason?.includes('invalid token ID') || fallbackErr?.code === 'CALL_EXCEPTION') {
              const msg = `Token ${tokenId} does not exist on L1 contract (stale event from old deployment)`
              console.warn(`[UserService] ${msg} — skipping`)
              throw new StaleTokenError(msg)
            }
            throw fallbackErr
          }
        } else {
          throw err
        }
      } else {
        throw err
      }
    }
    console.log(`[UserService] L1 query completed in ${Date.now() - queryStart}ms`)

    // Validate username - NEVER use defaults
    if (!username || username.trim() === '') {
      throw new Error(`Username not set on L1 contract for tokenId ${tokenId}. Cannot create user without username.`);
    }

    // atomic create‑or‑return (id = tokenId)
    // Default onboardingStep=5 (complete) since the user already minted and
    // has a username on-chain — if we're finding them via this helper, they
    // exist on-chain already. Callers doing fresh-mint onboarding (e.g.
    // /api/users/ensure from PostMintOnboarding) can override with step 0.
    const dbStart = Date.now()
    // Deterministic default avatar (1-100) derived from tokenId; matches the
    // frontend's getUserAvatar fallback so the placeholder is stable across
    // clients until the user explicitly picks a different one.
    const defaultAvatarId = (tokenId % 100) + 1

    user = await prisma.user.upsert({
      where:  { tokenId },
      update: {},           // no changes if it already exists
      create: {
        id: tokenId,
        address:  ownerAddress.toLowerCase(),  // Use actual wallet address from blockchain
        tokenId,
        username: username.trim(),
        image: '',  // L2 contract doesn't store images
        defaultAvatarId,
        onboardingStep: opts.onboardingStep ?? 5,
      },
    });
    console.log(`[UserService] Created user tokenId=${tokenId} username=${username} (${Date.now() - dbStart}ms)`)
  }

  return user.tokenId;
}


/**
 * Returns true if the User row looks like a placeholder created by an
 * eager-FK write (e.g. actions.ts upsert path that needs the FK to point
 * somewhere before the indexer has resolved the real Mint event). The
 * shape is `username='user_<tokenId>'` AND `address=''` — both deliberate
 * sentinels. We use this to distinguish "row stale, please refresh from
 * chain" from "row real, address just happens to be empty for some other
 * reason" (which shouldn't happen but a strict check makes it safer to
 * automatically overwrite).
 */
export function isPlaceholderUser(u: { tokenId: number; username: string; address: string }): boolean {
  return u.address === '' && u.username === `user_${u.tokenId}`
}

/**
 * Re-read the chain for tokenId and overwrite the local User row's
 * username + address with the canonical values. Called by the DataCleaner
 * sweep on rows that match isPlaceholderUser. Throws StaleTokenError if
 * the token doesn't exist on the current L1 contract (e.g. event from a
 * pre-redeploy era); the caller should mark the row so the sweep skips
 * it next time.
 *
 * Pre-existing comment in doFindOrCreateUser: `usernames` array is 0-indexed
 * but tokenIds are 1-indexed, hence `tokenId - 1`. Same convention here.
 */
export async function refreshUserFromChain(tokenId: number): Promise<{ tokenId: number; username: string; address: string }> {
  const { contract: l1Contract } = await getL1Provider()
  let owner: string
  let username: string
  try {
    ;[owner, username] = await Promise.all([
      l1Contract.ownerOf(tokenId),
      l1Contract.usernames(tokenId - 1),
    ])
  } catch (err: any) {
    if (err?.reason?.includes('invalid token ID') || err?.code === 'CALL_EXCEPTION') {
      throw new StaleTokenError(`Token ${tokenId} does not exist on L1 contract`)
    }
    // Try HTTP fallback if WS read flaked (mirrors the doFindOrCreateUser
    // pattern). Less elaborate retry chain since the caller is a periodic
    // background sweep — if HTTP also fails we just retry next tick.
    const httpUrl = getL1HttpRpcUrl()
    if (!httpUrl) throw err
    const httpProvider = makeJsonRpcProvider(httpUrl, 11155111)
    const httpContract = new Contract(CAW_NAMES_ADDRESS, CawProfileL1Abi, httpProvider)
    ;[owner, username] = await Promise.all([
      httpContract.ownerOf(tokenId),
      httpContract.usernames(tokenId - 1),
    ])
    l1Provider = null
    l1NameContract = null
  }
  if (!username || username.trim() === '') {
    throw new Error(`Empty username for tokenId ${tokenId} on L1 contract — refusing to overwrite placeholder`)
  }
  const updated = await prisma.user.update({
    where: { tokenId },
    data: {
      username: username.trim(),
      address: owner.toLowerCase(),
    },
    select: { tokenId: true, username: true, address: true },
  })
  // The cached findOrCreateUser entry for this tokenId may now hold a
  // promise that resolved against the placeholder state; drop it so the
  // next call re-reads the fresh row.
  userCache.delete(tokenId)
  console.log(`[UserService] Refreshed stale user tokenId=${tokenId} → username=${updated.username} owner=${updated.address}`)
  return updated
}

/**
 * syncTokensOwnedByWallet
 * Looks up tokens owned by a specific wallet via L1 balanceOf +
 * tokenOfOwnerByIndex. O(tokensOwned) instead of scanning every user row.
 * SPECIFIC wallet by asking L1 directly (balanceOf + tokenOfOwnerByIndex)
 * instead of scanning every user in the DB.
 *
 * For each token the wallet owns:
 *   - If the DB has it under a different address, update the row.
 *   - If the DB doesn't have it (first time seeing it on this node),
 *     ensure a User row exists via findOrCreateUser.
 *
 * Returns the list of tokenIds now confirmed as belonging to `walletAddress`.
 *
 * This is the interim fix until the NFT Transfer event watcher lands — the
 * watcher will keep User.address current proactively, eliminating any need
 * for just-in-time refresh.
 */
export async function syncTokensOwnedByWallet(walletAddress: string): Promise<number[]> {
  const normalized = walletAddress.toLowerCase()

  try {
    const { contract: l1Contract } = await getL1Provider()
    const balance = Number(await l1Contract.balanceOf(walletAddress))
    if (balance === 0) return []

    const tokenIds: number[] = []
    for (let i = 0; i < balance; i++) {
      try {
        const tokenId = Number(await l1Contract.tokenOfOwnerByIndex(walletAddress, i))
        tokenIds.push(tokenId)
      } catch (err: any) {
        console.warn(`[UserService] tokenOfOwnerByIndex(${walletAddress}, ${i}) failed:`, err.message)
      }
    }

    for (const tokenId of tokenIds) {
      const user = await prisma.user.findUnique({ where: { tokenId } })
      if (!user) {
        try {
          await findOrCreateUser(tokenId)
        } catch (err: any) {
          console.warn(`[UserService] findOrCreateUser(${tokenId}) during ownership sync failed:`, err.message)
        }
      } else if (user.address.toLowerCase() !== normalized) {
        console.log(`[UserService] Ownership changed for tokenId=${tokenId}: ${user.address} → ${normalized}`)
        await prisma.user.update({ where: { tokenId }, data: { address: normalized } })
      }
    }

    return tokenIds
  } catch (err: any) {
    console.error('[UserService] syncTokensOwnedByWallet failed:', err.message)
    return []
  }
}

/**
 * verifyOwnershipOnChain
 * L1 is the authoritative source of CAW name ownership — the L2 mirror can
 * lag (LZ delivery takes 1–5 min after mints/transfers) but never overrides
 * L1. Checking L1 alone also handles the fresh-mint window that was tripping
 * /api/auth/verify-dm: the L1 tx is instant, so ownerOf returns the minter
 * immediately. Returns true only on an L1 match.
 */
export async function verifyOwnershipOnChain(
  tokenId: number,
  expectedAddress: string,
): Promise<boolean> {
  try {
    const { contract: l1Contract } = await getL1Provider()
    const owner: string = await l1Contract.ownerOf(tokenId)
    return owner.toLowerCase() === expectedAddress.toLowerCase()
  } catch (err: any) {
    // ownerOf reverts for non-existent tokens.
    console.warn(`[UserService] L1 ownerOf(${tokenId}) failed: ${err?.message}`)
    return false
  }
}

/**
 * enrichUser
 * - calls L2 tokenURI, decodes base64 JSON, writes username+image
 */
async function enrichUser(userId: number, tokenId: number) {
  try {
    const { contract: l2Contract } = await getL2Provider()
    const uri = await l2Contract.tokenURI(tokenId)
    const b64 = uri.split(',')[1]
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    await prisma.user.update({
      where: { id: userId },
      data: { username: json.name, image: json.image }
    })
  } catch (err: any) {
    console.warn(`No L2 NFT metadata found for tokenId=${tokenId}`, err.message)
  }
}

