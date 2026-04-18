import { prisma } from '../prismaClient'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../abi/addresses'
import { Contract, WebSocketProvider, JsonRpcProvider } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider } from '../utils/rpcProvider'

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
  'function ownerOf(uint256 tokenId) view returns (address)'
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
async function createWebSocketProvider(rpcUrl: string, name: string): Promise<WebSocketProvider> {
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
      provider = makeWebSocketProvider(rpcUrl)

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
    const rpcUrl = process.env.L2_RPC_URL
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
      l2Provider = await createWebSocketProvider(rpcUrl, 'L2')
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
    const rpcUrl = process.env.L1_RPC_URL
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
      l1Provider = await createWebSocketProvider(rpcUrl, 'L1')
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

/**
 * findOrCreateUser
 * - uses on‑chain senderId as both L2 address and NFT tokenId
 */
export async function findOrCreateUser(
  senderId: number,
  opts: { onboardingStep?: number } = {},
) {
  const startTime = Date.now()
  const tokenId = senderId;
  console.log(`[UserService] findOrCreateUser START tokenId=${tokenId}`)

  if (tokenId === 0) {
    throw new Error("senderId cannot be zero");
  }

  console.log(`[UserService] Checking if user exists in DB...`)
  let user = await prisma.user.findUnique({
    where: { tokenId: senderId }
  })

  if (!user) {
    console.log(`[UserService] User not in DB, querying L1 blockchain...`)

    // Get providers lazily - only created when needed (with rate limit handling)
    const providerStart = Date.now()
    const { contract: l1Contract } = await getL1Provider()
    console.log(`[UserService] L1 provider ready in ${Date.now() - providerStart}ms`)

    // Query L1 for owner address and username (L1 is authoritative — L2 may not have the token yet)
    console.log(`[UserService] Querying L1 for tokenId=${tokenId}...`)
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
        const httpUrl = (process.env.L1_RPC_URL || '').replace(/^wss:/, 'https:').replace('/ws/', '/')
        if (httpUrl) {
          const httpProvider = makeJsonRpcProvider(httpUrl)
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

    console.log(`[UserService] Creating user in DB: tokenId=${tokenId}, owner=${ownerAddress}, username=${username}`);

    // atomic create‑or‑return (id = tokenId)
    // Default onboardingStep=5 (complete) since the user already minted and
    // has a username on-chain — if we're finding them via this helper, they
    // exist on-chain already. Callers doing fresh-mint onboarding (e.g.
    // /api/users/ensure from PostMintOnboarding) can override with step 0.
    const dbStart = Date.now()
    // Assign a random default avatar (1-100) for the placeholder shown when
    // the user hasn't uploaded a custom avatar. avatarUrl stays null.
    const randomAvatarId = Math.floor(Math.random() * 100) + 1

    user = await prisma.user.upsert({
      where:  { tokenId },
      update: {},           // no changes if it already exists
      create: {
        id: tokenId,
        address:  ownerAddress.toLowerCase(),  // Use actual wallet address from blockchain
        tokenId,
        username: username.trim(),
        image: '',  // L2 contract doesn't store images
        defaultAvatarId: randomAvatarId,
        onboardingStep: opts.onboardingStep ?? 5,
      },
    });
    console.log(`[UserService] User created in DB in ${Date.now() - dbStart}ms`)
  } else {
    console.log(`[UserService] User already exists in DB: tokenId=${user.tokenId}, username=${user.username}`)
  }

  const totalDuration = Date.now() - startTime
  console.log(`[UserService] findOrCreateUser COMPLETE in ${totalDuration}ms, returning tokenId=${user.tokenId}`)
  return user.tokenId;
}


/**
 * refreshOwnership
 * Checks all known users against L2 on-chain ownerOf and updates any stale addresses.
 * Called when a verified wallet doesn't match any DB records, suggesting a transfer happened.
 * Returns tokenIds now owned by the given address.
 */
export async function refreshOwnership(walletAddress: string): Promise<number[]> {
  const normalized = walletAddress.toLowerCase()

  try {
    const { contract: l2Contract } = await getL2Provider()

    // Get all users to check ownership (typically a small set — hundreds, not millions)
    const users = await prisma.user.findMany({
      select: { id: true, tokenId: true, address: true }
    })

    const updated: number[] = []

    for (const user of users) {
      try {
        const onChainOwner: string = await l2Contract.ownerOf(user.tokenId)
        const onChainLower = onChainOwner.toLowerCase()

        if (onChainLower !== user.address.toLowerCase()) {
          // Ownership changed on-chain — update DB
          console.log(`[UserService] Ownership changed for tokenId=${user.tokenId}: ${user.address} → ${onChainLower}`)
          await prisma.user.update({
            where: { tokenId: user.tokenId },
            data: { address: onChainLower }
          })
        }

        if (onChainLower === normalized) {
          updated.push(user.tokenId)
        }
      } catch (err: any) {
        // ownerOf may revert for non-existent tokens on L2
        console.warn(`[UserService] Could not check ownerOf for tokenId=${user.tokenId}:`, err.message)
      }
    }

    return updated
  } catch (err: any) {
    console.error('[UserService] refreshOwnership failed:', err.message)
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

