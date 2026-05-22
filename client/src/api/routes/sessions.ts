import { Router } from 'express'
import { randomUUID } from 'crypto'
import { ethers, Contract, JsonRpcProvider, WebSocketProvider } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import { getValidatorSigner, type ValidatorSigner } from '../../utils/signer'
import { cawProfileL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'
import { prisma } from '../../prismaClient'
// Tier 3 of the "RPC out of API request handlers" refactor (PROJECT_BACKLOG.md):
// syncTokensOwnedByWallet is intentionally NOT imported. POST /api/sessions
// reads ownership from the DB only; on a miss we return 202 and let the
// frontend retry while NftTransferWatcher catches up.
import Redis from 'ioredis'

const router = Router()
// Honor REDIS_URL — see sessionStore.ts for the same pattern + reasoning.
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

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

// Track pending requests for polling. Redis-backed so a server restart
// mid-request doesn't break the FE's 4-minute poll loop (the FE would
// otherwise see 404 forever and surface a generic "something went wrong"
// even though the on-chain tx may have landed in another process or
// be observable elsewhere). The in-memory Map stays as a write-through
// cache so same-process polls don't hit Redis on every read.
type SessionRequest = {
  status: 'waiting_for_sync' | 'submitting' | 'pending' | 'confirmed' | 'failed'
  txHash?: string
  blockNumber?: number
  error?: string
}
const requests = new Map<string, SessionRequest>()

const SESSION_REQUEST_TTL = 10 * 60 // seconds — matches the in-memory cleanup below
function sessionRequestKey(requestId: string): string {
  return `session_request:${requestId}`
}
async function setSessionRequest(requestId: string, value: SessionRequest): Promise<void> {
  requests.set(requestId, value)
  try {
    await redis.set(sessionRequestKey(requestId), JSON.stringify(value), 'EX', SESSION_REQUEST_TTL)
  } catch (e) {
    // Best-effort: a Redis blip shouldn't break the in-process happy path.
    // The Map write above still gives every poll from THIS process the
    // current value; only cross-process / cross-restart polls degrade.
    console.warn('[Sessions] Failed to persist request state to Redis (non-fatal):', e)
  }
}
async function getSessionRequest(requestId: string): Promise<SessionRequest | null> {
  const cached = requests.get(requestId)
  if (cached) return cached
  try {
    const raw = await redis.get(sessionRequestKey(requestId))
    if (!raw) return null
    return JSON.parse(raw) as SessionRequest
  } catch (e) {
    console.warn('[Sessions] Failed to read request state from Redis:', e)
    return null
  }
}

// Lazy-initialized provider/signer
let _provider: JsonRpcProvider | WebSocketProvider | null = null
let _signer: ValidatorSigner | null = null
let _contract: Contract | null = null

function getContract() {
  if (_contract) return _contract
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('L2 RPC not configured')
  _provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _signer = getValidatorSigner({ provider: _provider })
  if (!_signer) throw new Error('Validator not configured')
  _contract = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileL2Abi as any, _signer.asEthersSigner())
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

function parseTipRateFromMessage(line: string): bigint {
  // "1000 CAW" — bare integer + " CAW", no K/M/B suffix; uint64-bounded
  const match = line.match(/^(\d+) CAW$/)
  if (!match) return 0n
  return BigInt(match[1])
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

    await setSessionRequest(requestId, { status: 'submitting' })
    console.log(`[Sessions] Using contract at: ${CAW_NAMES_L2_ADDRESS}`)
    const messageBytes = ethers.toUtf8Bytes(message)
    // bytes-form registerSessionPersonal post-v1-passkey refactor: signature
    // is passed as a raw bytes blob (r||s||v); the contract internally tries
    // ecrecover for 65-byte sigs, falls back to ERC-1271 for smart-EOA owners.
    // The signer (recoveredAddress) is now an explicit first arg so 1271
    // validation has an address to check; for plain EOA flows it's the same
    // address ecrecover would have produced.

    // Pass an explicit gasLimit HINT (not a cap) to estimateGas. Infura's Base
    // Sepolia endpoint rejects unbounded estimates with "intrinsic gas too high",
    // which ethers surfaces as a generic `missing revert data` CALL_EXCEPTION
    // that hides the real cause. A 2M hint comfortably covers the real cost
    // (~265k measured) while satisfying Infura's need for a bounded estimate.
    const estimated = await cawProfileL2.registerSessionPersonal.estimateGas(
      recoveredAddress, messageBytes, signature,
      { gasLimit: 2_000_000 }
    )
    const gasLimit = (estimated * 120n) / 100n // +20% headroom

    const tx = await cawProfileL2.registerSessionPersonal(
      recoveredAddress,
      messageBytes,
      signature,
      { gasLimit }
    )

    // Parse values from message for DB pre-population. Line layout (post
    // perActionTipRate addition): 0 header, 1 sep, 2 spend label, 3 spend
    // value, 4 blank, 5 tip label, 6 tip value, 7 blank, 8 expires label,
    // 9 expires value, 10 blank, 11 key label, 12 key value.
    const lines = message.split('\n')
    const sessionKey = (lines[12] || '').trim()
    const expiry = parseExpiryFromMessage(lines[9] || '')
    const scopeBitmap = 0xBF
    const spendLimit = parseSpendLimitFromMessage(lines[3] || '')
    const perActionTipRate = parseTipRateFromMessage(lines[6] || '')

    console.log(`[Sessions] Submitted tx: ${tx.hash}`)
    await setSessionRequest(requestId, { status: 'pending', txHash: tx.hash })

    const receipt = await tx.wait()
    console.log(`[Sessions] Confirmed tx ${tx.hash} in block ${receipt.blockNumber}`)
    await setSessionRequest(requestId, { status: 'confirmed', txHash: tx.hash, blockNumber: receipt.blockNumber })

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
          perActionTipRate: perActionTipRate.toString(),
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
          perActionTipRate: perActionTipRate.toString(),
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
    await setSessionRequest(requestId, { status: 'failed', error: userError })
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

    // Validate message format (13 lines after perActionTipRate addition)
    const lines = (message as string).split('\n')
    if (lines.length !== 13 || lines[0] !== 'Enable Quick Sign') {
      return res.status(400).json({ error: 'Invalid message format' })
    }

    // Parse values:
    //   line 3  = spend limit value (e.g. "5M CAW")
    //   line 6  = tip rate value (e.g. "1000 CAW")
    //   line 9  = expiry value
    //   line 12 = session key address
    const spendLimit = parseSpendLimitFromMessage(lines[3])
    const expiry = parseExpiryFromMessage(lines[9])
    const sessionKey = lines[12]?.trim()

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
    let recoveredAddress: string
    try {
      recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase()
    } catch {
      return res.status(400).json({ error: 'Invalid signature' })
    }

    // Rate limit by full recovered address (Redis-backed)
    if (!await checkRateLimit(recoveredAddress)) {
      return res.status(429).json({ error: `You can only re-enable Quick Sign ${RATE_LIMIT_MAX} times per day.` })
    }

    // Block concurrent submissions for the same address
    if (inFlight.has(recoveredAddress)) {
      return res.status(409).json({ error: 'A session registration is already in progress for this address' })
    }

    // Verify the signer actually owns at least one CAW name (prevents gas
    // drain from random wallets). Tier 3: read DB only — no L1 fallback.
    // NftTransferWatcher updates User.address asynchronously; if the wallet
    // really does own a token the indexer hasn't seen yet, the frontend's
    // retryOnIndexing loop will catch up and the second pass will succeed.
    const ownedName = await prisma.user.findFirst({
      where: { address: { equals: recoveredAddress, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!ownedName) {
      console.log(`[Sessions] No tokens found in DB for ${recoveredAddress} — returning 202 (indexer may be catching up)`)
      res.setHeader('Retry-After', '5')
      return res.status(202).json({
        error: 'ownership not yet indexed',
        retryAfterSeconds: 5,
      })
    }

    // Create request and process in background
    const requestId = randomUUID()
    await setSessionRequest(requestId, { status: 'submitting' })
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
  // Falls back to Redis if the in-memory cache is cold (e.g. this process
  // just restarted while the FE was mid-poll). Returns 404 only when the
  // request is genuinely unknown to BOTH stores.
  const tracked = await getSessionRequest(requestId)
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
 *
 * Auth/spam guard: gated behind a Redis-backed per-IP rate limit AND a
 * per-(owner) rate limit. Without these, anyone could fish a leaked
 * revocation signature out of another node's logs and replay it N times,
 * draining the validator's ETH balance one failed-revert tx at a time.
 * The on-chain contract enforces signature correctness; this gate just
 * prevents calldata-replay grief. Audit fix 2026-05-09 (Round 5 API
 * CRITICAL-1).
 */
const REVOKE_IP_LIMIT = 30        // per 24h
const REVOKE_OWNER_LIMIT = 10     // per 24h
const REVOKE_WINDOW = 24 * 60 * 60

async function checkRevokeRateLimit(scope: string, key: string, max: number): Promise<boolean> {
  const k = `revoke_ratelimit:${scope}:${key}`
  const count = await redis.llen(k)
  if (count >= max) return false
  await redis.rpush(k, Date.now().toString())
  await redis.expire(k, REVOKE_WINDOW)
  return true
}

async function processRevokeRequest(
  requestId: string,
  owner: string,
  sessionKey: string,
  signature: string,
): Promise<void> {
  console.log(`[Sessions] Processing revocation ${requestId}`)
  try {
    const cawProfileL2 = getContract()
    const sig = ethers.Signature.from(signature)
    await setSessionRequest(requestId, { status: 'submitting' })

    const tx = await cawProfileL2.revokeSessionBySig(
      owner,
      sessionKey,
      sig.v,
      sig.r,
      sig.s,
    )
    console.log(`[Sessions] Revocation tx submitted: ${tx.hash}`)
    await setSessionRequest(requestId, { status: 'pending', txHash: tx.hash })

    const receipt = await tx.wait()
    console.log(`[Sessions] Session revoked on-chain in block ${receipt.blockNumber}`)
    await setSessionRequest(requestId, { status: 'confirmed', txHash: tx.hash, blockNumber: receipt.blockNumber })

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
  } catch (err: any) {
    console.error(`[Sessions] Revocation error for ${requestId}:`, err.message)
    await setSessionRequest(requestId, { status: 'failed', error: 'Failed to revoke session. Please try again.' })
  } finally {
    inFlight.delete(owner.toLowerCase())
    // Clean up after 10 minutes
    setTimeout(() => requests.delete(requestId), 10 * 60 * 1000)
  }
}

router.delete('/', async (req: any, res: any) => {
  try {
    const { owner, sessionKey, signature } = req.body

    if (!owner || !sessionKey || !signature) {
      return res.status(400).json({ error: 'Missing required fields: owner, sessionKey, signature' })
    }

    if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      return res.status(400).json({ error: 'Invalid owner address' })
    }
    if (typeof sessionKey !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sessionKey)) {
      return res.status(400).json({ error: 'Invalid sessionKey address' })
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ error: 'Invalid signature shape' })
    }

    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown'
    if (!(await checkRevokeRateLimit('ip', ip, REVOKE_IP_LIMIT))) {
      return res.status(429).json({ error: 'Rate limit: too many revocation requests from this IP' })
    }
    if (!(await checkRevokeRateLimit('owner', owner.toLowerCase(), REVOKE_OWNER_LIMIT))) {
      return res.status(429).json({ error: 'Rate limit: too many revocation requests for this owner' })
    }

    // Block concurrent submissions for the same owner (mirrors POST pattern)
    if (inFlight.has(owner.toLowerCase())) {
      return res.status(409).json({ error: 'A revocation is already in progress for this owner' })
    }

    // TODO(FE): the FE currently awaits a sync response from DELETE /api/sessions.
    // It should be updated to poll /api/sessions/status/:requestId for confirmed
    // status, matching the POST flow. Until then the FE will observe 202 and
    // the session will be revoked asynchronously; on-chain event via ChainSyncService
    // will prune the DB row when the tx confirms.
    const requestId = randomUUID()
    await setSessionRequest(requestId, { status: 'submitting' })
    inFlight.add(owner.toLowerCase())

    processRevokeRequest(requestId, owner, sessionKey, signature)

    return res.status(202).json({ requestId, status: 'pending' })
  } catch (err: any) {
    console.error('[Sessions] Revocation error:', err.message)
    return res.status(500).json({ error: 'Failed to revoke session' })
  }
})

export default router
