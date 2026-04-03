import { Router } from 'express'
import { randomUUID } from 'crypto'
import { ethers, Contract, Wallet, JsonRpcProvider, WebSocketProvider } from 'ethers'
import { cawNameL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'
import { refreshOwnership } from '../../services/UserService'
import Redis from 'ioredis'

const router = Router()
const redis = new Redis({ port: 6379, host: '127.0.0.1' })

const SESSION_DOMAIN = {
  name:              'CawNameL2',
  version:           '1',
  verifyingContract: CAW_NAMES_L2_ADDRESS,
}

const DELEGATION_TYPES = {
  SessionDelegation: [
    { name: 'sessionKey',     type: 'address'  },
    { name: 'expiry',         type: 'uint64'   },
    { name: 'scopeBitmap',    type: 'uint8'    },
    { name: 'spendLimit',     type: 'uint256'  },
  ],
}

// Rate limiting: 20 registrations per address per day (Redis-backed, survives restarts)
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW = 24 * 60 * 60 // seconds

async function checkRateLimit(address: string): Promise<boolean> {
  const key = `session_ratelimit:${address}`
  const count = await redis.llen(key)
  return count < RATE_LIMIT_MAX
}

async function recordRateLimit(address: string) {
  const key = `session_ratelimit:${address}`
  await redis.rpush(key, Date.now().toString())
  await redis.expire(key, RATE_LIMIT_WINDOW)
}

// Tracks addresses with an in-flight tx to prevent concurrent submissions
const inFlight = new Set<string>()

// Max expiry: 30 days
const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60

// Track pending requests for polling
type SessionRequest = {
  status: 'waiting_for_sync' | 'submitting' | 'pending' | 'confirmed' | 'failed'
  txHash?: string
  blockNumber?: number
  error?: string
}
const requests = new Map<string, SessionRequest>()

// Lazy-initialized provider/wallet
let _provider: JsonRpcProvider | WebSocketProvider | null = null
let _wallet: Wallet | null = null
let _contract: Contract | null = null

function getContract() {
  if (_contract) return _contract
  const rpcUrl = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL
  if (!rpcUrl) throw new Error('L2 RPC not configured')
  const validatorKey = process.env.VALIDATOR_PRIVATE_KEY
  if (!validatorKey) throw new Error('Validator not configured')
  _provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? new WebSocketProvider(rpcUrl)
    : new JsonRpcProvider(rpcUrl)
  _wallet = new Wallet(validatorKey, _provider)
  _contract = new Contract(CAW_NAMES_L2_ADDRESS, cawNameL2Abi as any, _wallet)
  return _contract
}

// requestCounter removed — using crypto.randomUUID()

/**
 * Background: submit session registration tx, record rate limit only on success
 */
async function processSessionRequest(
  requestId: string,
  recoveredAddress: string,
  delegation: any,
  signature: string
) {
  console.log(`[Sessions] Processing request ${requestId}`)

  try {
    const cawNameL2 = getContract()

    requests.set(requestId, { status: 'submitting' })
    const sig = ethers.Signature.from(signature)
    const { sessionKey, expiry, scopeBitmap, spendLimit } = delegation

    const tx = await cawNameL2.registerSession(
      sessionKey,
      BigInt(expiry),
      Number(scopeBitmap),
      BigInt(spendLimit),
      sig.v,
      sig.r,
      sig.s,
    )

    console.log(`[Sessions] Submitted tx: ${tx.hash}`)
    requests.set(requestId, { status: 'pending', txHash: tx.hash })

    const receipt = await tx.wait()
    console.log(`[Sessions] Confirmed tx ${tx.hash} in block ${receipt.blockNumber}`)
    requests.set(requestId, { status: 'confirmed', txHash: tx.hash, blockNumber: receipt.blockNumber })

    // Record in ValidatorTx for analytics
    const gasUsed = receipt.gasUsed.toString()
    const gasPrice = (receipt.gasPrice ?? tx.gasPrice ?? 0n).toString()
    const ethCost = (BigInt(gasUsed) * BigInt(gasPrice)).toString()
    try {
      await prisma.validatorTx.create({
        data: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber ? BigInt(receipt.blockNumber) : null,
          txType: 'sessionRegister',
          actionCount: 0,
          gasUsed,
          gasPrice,
          ethCost,
          tipCaw: '0',
          tipEthValue: '0',
          profit: `-${ethCost}`, // pure cost, no revenue
          validatorId: 0,
          status: 'confirmed',
          sessionUser: recoveredAddress,
        }
      })
    } catch (err: any) {
      console.error(`[Sessions] Failed to record tx analytics:`, err.message)
    }

    // Only count against rate limit on successful confirmation
    await recordRateLimit(recoveredAddress)
  } catch (err: any) {
    console.error(`[Sessions] Error processing ${requestId}:`, err.message)
    requests.set(requestId, { status: 'failed', error: err.message })
  } finally {
    inFlight.delete(recoveredAddress)
  }

  // Clean up after 10 minutes
  setTimeout(() => requests.delete(requestId), 10 * 60 * 1000)
}

/**
 * POST /api/sessions
 * Accepts an EIP-712 signed session delegation, validates the signature,
 * and kicks off background processing. Returns a requestId for polling.
 */
router.post('/', async (req: any, res: any) => {
  try {
    const { delegation, signature } = req.body

    if (!delegation || !signature) {
      return res.status(400).json({ error: 'Missing required fields: delegation and signature' })
    }

    const { sessionKey, expiry, scopeBitmap, spendLimit } = delegation
    if (!sessionKey || !expiry || scopeBitmap === undefined || spendLimit === undefined) {
      return res.status(400).json({ error: 'Missing delegation fields' })
    }

    // Server-side validation: reject expired or unreasonably long sessions before paying gas
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (Number(expiry) <= nowSeconds) {
      return res.status(400).json({ error: 'Session already expired' })
    }
    if (Number(expiry) - nowSeconds > MAX_EXPIRY_SECONDS) {
      return res.status(400).json({ error: 'Session expiry too far in the future (max 30 days)' })
    }

    // Reject forbidden scope bits server-side (WITHDRAW=0x40, OTHER=0x80)
    if ((Number(scopeBitmap) & 0xC0) !== 0) {
      return res.status(400).json({ error: 'Cannot delegate WITHDRAW or OTHER actions' })
    }

    // Verify EIP-712 signature to recover signer address (fast, no RPC needed)
    const message = {
      sessionKey,
      expiry:        BigInt(expiry),
      scopeBitmap:   Number(scopeBitmap),
      spendLimit:    BigInt(spendLimit),
    }
    const domain = { ...SESSION_DOMAIN, chainId: Number(process.env.L2_CHAIN_ID || 84532) }

    const recoveredAddress = ethers.verifyTypedData(
      domain,
      DELEGATION_TYPES,
      message,
      signature
    ).toLowerCase()

    // Rate limit by full recovered address (Redis-backed)
    if (!await checkRateLimit(recoveredAddress)) {
      return res.status(429).json({ error: `You can only re-enable Quick Sign ${RATE_LIMIT_MAX} times per day.` })
    }

    // Block concurrent submissions for the same address
    if (inFlight.has(recoveredAddress)) {
      return res.status(409).json({ error: 'A session registration is already in progress for this address' })
    }

    // Verify the signer actually owns at least one CAW name (prevents gas drain from random wallets)
    let ownedName = await prisma.user.findFirst({
      where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
      select: { id: true },
    })
    // If no match in DB, the NFT may have been transferred — check L2 on-chain
    if (!ownedName) {
      console.log(`[Sessions] No tokens found for ${recoveredAddress} in DB, checking on-chain ownership...`)
      const refreshed = await refreshOwnership(recoveredAddress)
      if (refreshed.length > 0) {
        console.log(`[Sessions] Found ${refreshed.length} token(s) after ownership refresh:`, refreshed)
        ownedName = await prisma.user.findFirst({
          where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
          select: { id: true },
        })
      }
    }
    if (!ownedName) {
      return res.status(403).json({ error: 'Signer does not own any CAW names' })
    }

    // Create request and process in background
    const requestId = randomUUID()
    requests.set(requestId, { status: 'submitting' })
    inFlight.add(recoveredAddress)

    processSessionRequest(requestId, recoveredAddress, delegation, signature)

    return res.json({ requestId, status: 'submitting' })
  } catch (err: any) {
    console.error('[Sessions] Error:', err.message)
    return res.status(500).json({ error: 'Failed to register session' })
  }
})

/**
 * GET /api/sessions/status/:requestId
 * Poll for session registration progress
 */
router.get('/status/:requestId', async (req: any, res: any) => {
  const { requestId } = req.params
  const tracked = requests.get(requestId)
  if (!tracked) {
    return res.status(404).json({ error: 'Request not found' })
  }
  return res.json(tracked)
})

/**
 * DELETE /api/sessions
 * Revoke a session key on-chain using a signature from the session key itself.
 * The session key signs an EIP-712 RevokeSession message, and the validator
 * submits it on-chain via revokeSessionBySig.
 */
router.delete('/', async (req: any, res: any) => {
  try {
    const { owner, sessionKey, signature } = req.body

    if (!owner || !sessionKey || !signature) {
      return res.status(400).json({ error: 'Missing required fields: owner, sessionKey, signature' })
    }

    const cawNameL2 = getContract()
    const sig = ethers.Signature.from(signature)

    const tx = await cawNameL2.revokeSessionBySig(
      owner,
      sessionKey,
      sig.v,
      sig.r,
      sig.s,
    )

    console.log(`[Sessions] Revocation tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    console.log(`[Sessions] Session revoked on-chain in block ${receipt.blockNumber}`)

    // Record in ValidatorTx for analytics
    const gasUsed = receipt.gasUsed.toString()
    const gasPrice = (receipt.gasPrice ?? tx.gasPrice ?? 0n).toString()
    const ethCost = (BigInt(gasUsed) * BigInt(gasPrice)).toString()
    try {
      await prisma.validatorTx.create({
        data: {
          txHash: tx.hash,
          blockNumber: receipt.blockNumber ? BigInt(receipt.blockNumber) : null,
          txType: 'sessionRevoke',
          actionCount: 0,
          gasUsed,
          gasPrice,
          ethCost,
          tipCaw: '0',
          tipEthValue: '0',
          profit: `-${ethCost}`,
          validatorId: 0,
          status: 'confirmed',
          sessionUser: owner.toLowerCase(),
        }
      })
    } catch (err: any) {
      console.error(`[Sessions] Failed to record revocation tx analytics:`, err.message)
    }

    return res.json({ success: true, txHash: tx.hash })
  } catch (err: any) {
    console.error('[Sessions] Revocation error:', err.message)
    return res.status(500).json({ error: 'Failed to revoke session' })
  }
})

export default router
