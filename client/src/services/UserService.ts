import { prisma } from '../prismaClient'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../abi/addresses'
import { Contract, WebSocketProvider } from 'ethers'

const CawNameL2Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getTokens(uint32[] tokenIds) view returns (tuple(uint256 tokenId, uint256 balance, string username, uint256 cawBalance, uint256 nextCawonce)[])'
]

const CawNameL1Abi = [
  'function usernames(uint256 index) view returns (string)'
]

// Lazy-initialized providers - only created when first needed
let l2Provider: WebSocketProvider | null = null
let l2NameContract: Contract | null = null
let l1Provider: WebSocketProvider | null = null
let l1NameContract: Contract | null = null

function getL2Provider() {
  if (!l2Provider) {
    console.log('[UserService] Initializing L2 WebSocket provider...')
    l2Provider = new WebSocketProvider(
      process.env.L2_RPC_URL || 'wss://base-sepolia.infura.io/ws/v3/YOUR_INFURA_PROJECT_ID'
    )
    l2NameContract = new Contract(
      CAW_NAMES_L2_ADDRESS,
      CawNameL2Abi,
      l2Provider
    )
  }
  return { provider: l2Provider, contract: l2NameContract! }
}

function getL1Provider() {
  if (!l1Provider) {
    console.log('[UserService] Initializing L1 WebSocket provider...')
    l1Provider = new WebSocketProvider(
      process.env.L1_RPC_URL || 'wss://eth-sepolia.g.alchemy.com/v2/demo'
    )
    l1NameContract = new Contract(
      CAW_NAMES_ADDRESS,
      CawNameL1Abi,
      l1Provider
    )
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
    // Get providers lazily - only created when needed
    const { contract: l2Contract } = getL2Provider()
    const { contract: l1Contract } = getL1Provider()

    // Query L2 for owner address and L1 for username
    const [ownerAddress, username] = await Promise.all([
      l2Contract.ownerOf(tokenId),
      l1Contract.usernames(tokenId - 1) // usernames array is 0-indexed, tokenIds start at 1
    ]);

    // Validate username - NEVER use defaults
    if (!username || username.trim() === '') {
      throw new Error(`Username not set on L1 contract for tokenId ${tokenId}. Cannot create user without username.`);
    }

    console.log(`Creating user from blockchain: tokenId=${tokenId}, owner=${ownerAddress}, username=${username}`);

    // atomic create‑or‑return
    user = await prisma.user.upsert({
      where:  { tokenId },
      update: {},           // no changes if it already exists
      create: {
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
    const { contract: l2Contract } = getL2Provider()
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

