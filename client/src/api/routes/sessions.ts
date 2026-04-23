import { Router } from 'express'
import { randomUUID } from 'crypto'
import { ethers, Contract, Wallet, JsonRpcProvider, WebSocketProvider } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider } from '../../utils/rpcProvider'
import { cawProfileL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'
import { syncTokensOwnedByWallet } from '../../services/UserService'
import Redis from 'ioredis'

const router = Router()
const redis = new Redis({ port: 6379, host: '127.0.0.1' })

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

// Max expiry: 1 year
const MAX_EXPIRY_SECONDS = 365 * 24 * 60 * 60

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
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _wallet = new Wallet(validatorKey, _provider)
  _contract = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileL2Abi as any, _wallet)
  return _contract
}

// requestCounter removed — using crypto.randomUUID()

const MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
}

function parseExpiryFromMessage(line: string): number {
  // "25 April 2026 00:00:00 UTC"
  const match = line.match(/(\d+) (\w+) (\d+) (\d+):(\d+):(\d+) UTC/)
  if (!match) return 0
  const [, day, month, year, hh, mm, ss] = match
  const d = new Date(Date.UTC(+year, MONTHS[month] ?? 0, +day, +hh, +mm, +ss))
  return Math.floor(d.getTime() / 1000)
}

function parseSpendLimitFromMessage(line: string): bigint {
  // "5M CAW"
  const match = line.match(/(\d+)([KMB]) CAW/)
  if (!match) return 0n
  const [, num, unit] = match
  const multiplier = unit === 'B' ? 1_000_000_000n : unit === 'M' ? 1_000_000n : 1_000n
  return BigInt(num) * multiplier
}

/**
 * Background: submit session registration tx, record rate limit only on success
 */
async function processSessionRequest(
  requestId: string,
  recoveredAddress: string,
  message: string,
  signature: string
) {
  console.log(`[Sessions] Processing request ${requestId}`)

  try {
    const cawProfileL2 = getContract()

    requests.set(requestId, { status: 'submitting' })
    console.log(`[Sessions] Using contract at: ${CAW_NAMES_L2_ADDRESS}`)
    const sig = ethers.Signature.from(signature)
    const messageBytes = ethers.toUtf8Bytes(message)

    // Pass an explicit gasLimit HINT (not a cap) to estimateGas. Infura's Base
    // Sepolia endpoint rejects unbounded estimates with "intrinsic gas too high",
    // which ethers surfaces as a generic `missing revert data` CALL_EXCEPTION
    // that hides the real cause. A 2M hint comfortably covers the real cost
    // (~265k measured) while satisfying Infura's need for a bounded estimate.
    const estimated = await cawProfileL2.registerSessionPersonal.estimateGas(
      messageBytes, sig.v, sig.r, sig.s,
      { gasLimit: 2_000_000 }
    )
    const gasLimit = (estimated * 120n) / 100n // +20% headroom

    const tx = await cawProfileL2.registerSessionPersonal(
      messageBytes,
      sig.v,
      sig.r,
      sig.s,
      { gasLimit }
    )

    // Parse values from message for DB pre-population
    const lines = message.split('\n')
    const sessionKey = (lines[9] || '').trim()
    const expiry = parseExpiryFromMessage(lines[6] || '')
    const scopeBitmap = 0xBF
    const spendLimit = parseSpendLimitFromMessage(lines[3] || '')

    console.log(`[Sessions] Submitted tx: ${tx.hash}`)
    requests.set(requestId, { status: 'pending', txHash: tx.hash })

    const receipt = await tx.wait()
    console.log(`[Sessions] Confirmed tx ${tx.hash} in block ${receipt.blockNumber}`)
    requests.set(requestId, { status: 'confirmed', txHash: tx.hash, blockNumber: receipt.blockNumber })

    // Pre-populate the SessionKey table so the user's next action hits the
    // DB fast path instead of falling back to a live RPC call. The L2Events
    // indexer will eventually produce the same row from the SessionCreated
    // event, but it runs every 15s — writing here eliminates the cold-start
    // RPC on the very first action after Quick Sign activation.
    try {
      const ownerLc = recoveredAddress.toLowerCase()
      const sessionLc = String(sessionKey).toLowerCase()
      await prisma.sessionKey.upsert({
        where: { ownerAddress_sessionAddress: { ownerAddress: ownerLc, sessionAddress: sessionLc } },
        update: {
          expiry: BigInt(expiry),
          scopeBitmap: Number(scopeBitmap),
          spendLimit: BigInt(spendLimit).toString(),
          spent: '0',             // fresh session starts at zero
          revokedAt: null,        // re-creating clears any prior revocation
          lastSyncedAt: new Date(),
        },
        create: {
          ownerAddress: ownerLc,
          sessionAddress: sessionLc,
          expiry: BigInt(expiry),
          scopeBitmap: Number(scopeBitmap),
          spendLimit: BigInt(spendLimit).toString(),
          lastSyncedAt: new Date(),
        },
      })
    } catch (err: any) {
      console.warn(`[Sessions] Failed to pre-populate SessionKey row (indexer will backfill):`, err.message)
    }

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
    console.error(`[Sessions] Full error:`, JSON.stringify({ reason: err.reason, code: err.code, data: err.data, revert: err.revert }, null, 2))
    const rawMsg = (err.reason || err.message || '')
    const rawLower = rawMsg.toLowerCase()
    console.error(`[Sessions] Raw error for ${requestId}:`, rawMsg)
    let userError = 'Something went wrong. Please try again.'
    if (rawLower.includes('cannot delegate withdraw')) {
      userError = 'This action type cannot be delegated to Quick Sign.'
    } else if (rawLower.includes('already expired')) {
      userError = 'Session duration is invalid. Please try again.'
    } else if (rawLower.includes('insufficient funds') && !rawLower.includes('gas')) {
      userError = 'Validator has insufficient funds. Please contact the node operator.'
    } else if (rawLower.includes('nonce') && rawLower.includes('too low')) {
      userError = 'Transaction conflict. Please try again.'
    }
    requests.set(requestId, { status: 'failed', error: userError })
  } finally {
    inFlight.delete(recoveredAddress)
  }

  // Clean up after 10 minutes
  setTimeout(() => requests.delete(requestId), 10 * 60 * 1000)
}

/**
 * POST /api/sessions
 * Accepts a personal_sign signed session message, validates the signature,
 * and kicks off background processing. Returns a requestId for polling.
 */
router.post('/', async (req: any, res: any) => {
  try {
    const { message, signature } = req.body

    if (!message || !signature) {
      return res.status(400).json({ error: 'Missing required fields: message and signature' })
    }

    // Validate message format (10 lines)
    const lines = (message as string).split('\n')
    if (lines.length !== 10 || lines[0] !== 'Enable Quick Sign') {
      return res.status(400).json({ error: 'Invalid message format' })
    }

    // Parse values: line 3 = spend limit value, line 6 = expiry value, line 9 = address
    const spendLimit = parseSpendLimitFromMessage(lines[3])
    const expiry = parseExpiryFromMessage(lines[6])
    const sessionKey = lines[9]?.trim()

    if (!sessionKey || !expiry) {
      return res.status(400).json({ error: 'Could not parse session parameters from message' })
    }

    // Server-side validation
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (expiry <= nowSeconds) {
      return res.status(400).json({ error: 'Session already expired' })
    }
    if (expiry - nowSeconds > MAX_EXPIRY_SECONDS) {
      return res.status(400).json({ error: 'Session expiry too far in the future (max 1 year)' })
    }

    // Recover signer from personal_sign
    const recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase()

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
      const refreshed = await syncTokensOwnedByWallet(recoveredAddress)
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

    processSessionRequest(requestId, recoveredAddress, message, signature)

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

    const cawProfileL2 = getContract()
    const sig = ethers.Signature.from(signature)

    const tx = await cawProfileL2.revokeSessionBySig(
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
