import { prisma } from '../prismaClient'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../abi/addresses'
import { Contract, WebSocketProvider } from 'ethers'

const CawNameL2Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getTokens(uint32[] tokenIds) view returns (tuple(uint256 tokenId, uint256 balance, string username, uint256 cawBalance, uint256 nextCawonce)[])'
]

const CawNameL1Abi = [
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
      provider = new WebSocketProvider(rpcUrl)

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

      // Wait for ready - in ethers v6, ready is a Promise
      const readyPromise = provider.ready
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
        CawNameL2Abi,
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
        CawNameL1Abi,
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
export async function findOrCreateUser(senderId: number) {
  const tokenId = senderId;
  if (tokenId === 0) {
    throw new Error("senderId cannot be zero");
  }

  let user = await prisma.user.findUnique({
    where: { tokenId: senderId }
  })

  if (!user) {
    // Get providers lazily - only created when needed (with rate limit handling)
    const { contract: l1Contract } = await getL1Provider()

    // Query L1 for owner address and username (L1 is authoritative — L2 may not have the token yet)
    const [ownerAddress, username] = await Promise.all([
      l1Contract.ownerOf(tokenId),
      l1Contract.usernames(tokenId - 1) // usernames array is 0-indexed, tokenIds start at 1
    ]);

    // Validate username - NEVER use defaults
    if (!username || username.trim() === '') {
      throw new Error(`Username not set on L1 contract for tokenId ${tokenId}. Cannot create user without username.`);
    }

    console.log(`Creating user from blockchain: tokenId=${tokenId}, owner=${ownerAddress}, username=${username}`);

    // atomic create‑or‑return (id = tokenId)
    user = await prisma.user.upsert({
      where:  { tokenId },
      update: {},           // no changes if it already exists
      create: {
        id: tokenId,
        address:  ownerAddress.toLowerCase(),  // Use actual wallet address from blockchain
        tokenId,
        username: username.trim(),
        image: '',  // L2 contract doesn't store images
      },
    });
  }

  return user.tokenId;
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

