/**
 * /api/sponsor — sponsored L1 mint / deposit / authenticate for Population B
 * (EIP-7702 SmartEOA users).
 *
 * Three endpoints:
 *   POST /api/sponsor/bootstrap    — single type-4 tx: 7702 delegation +
 *                                    SmartEOA.initialize + mintAndDepositSponsored
 *   POST /api/sponsor/deposit      — depositForSponsored (subsequent deposits)
 *   POST /api/sponsor/authenticate — authenticateSponsored (second-network auth)
 *
 * Anti-abuse:
 *   - Bootstrap:     3 calls / IP / 24 h (Redis-backed)
 *   - Deposit/Auth: 30 calls / IP / 24 h (Redis-backed)
 *   - SPONSOR_ENABLED kill-switch: 503 when disabled
 *   - Minimum deposit check for bootstrap (SPONSOR_MIN_DEPOSIT_CAW)
 *
 * Errors returned as { error: 'CODE', detail: '...' } with appropriate
 * HTTP status codes. On-chain reverts surface as 400 with structured codes.
 */

import { Router } from 'express'
import { z, ZodError } from 'zod'
import Redis from 'ioredis'
import {
  getSponsorService,
  isSponsorError,
} from '../../services/SponsorService'

const router = Router()

// ─── Redis for rate limiting ─────────────────────────────────────────────────

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// ─── Rate limit helpers ──────────────────────────────────────────────────────

const BOOTSTRAP_RATE_LIMIT     = 3
const DEPOSIT_AUTH_RATE_LIMIT  = 30
const RATE_WINDOW_SECONDS      = 24 * 60 * 60   // 24 hours

/**
 * Increment-and-check by IP for the given operation.
 * Returns true if allowed, false if over limit.
 * Fails open on Redis error (same pattern as freeActionRateLimit.ts).
 */
async function checkSponsorRateLimit(ip: string, op: 'bootstrap' | 'deposit' | 'authenticate'): Promise<boolean> {
  const limit = op === 'bootstrap' ? BOOTSTRAP_RATE_LIMIT : DEPOSIT_AUTH_RATE_LIMIT
  const key = `sponsor:${op}:${ip}`
  try {
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, RATE_WINDOW_SECONDS)
    } else {
      const ttl = await redis.ttl(key)
      if (ttl < 0) await redis.expire(key, RATE_WINDOW_SECONDS)
    }
    return count <= limit
  } catch {
    return true  // fail open on Redis unavailability
  }
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex')
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be 0x-prefixed 20-byte address')
const hexBytesSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'must be 0x-prefixed even-length hex')
// bigint from string/number (JSON doesn't support BigInt natively)
const bigintSchema = z.union([
  z.string().regex(/^\d+$/).transform(v => BigInt(v)),
  z.number().int().nonnegative().transform(v => BigInt(v)),
])

const authTupleSignatureSchema = z.object({
  yParity: z.number().int().gte(0).lte(1),
  r: hex32Schema as z.ZodType<`0x${string}`>,
  s: hex32Schema as z.ZodType<`0x${string}`>,
})

const BootstrapBodySchema = z.object({
  passkeyPubkeyX:     hex32Schema as z.ZodType<`0x${string}`>,
  passkeyPubkeyY:     hex32Schema as z.ZodType<`0x${string}`>,
  ecdsaFallbackAddr:  addressSchema as z.ZodType<`0x${string}`>,
  username:           z.string().min(1).max(32),
  depositAmountCAW:   bigintSchema,
  networkId:          z.number().int().nonnegative(),
  lzDestId:           z.number().int().nonnegative(),
  lzTokenAmount:      bigintSchema,
  authTupleSignature: authTupleSignatureSchema,
  authTupleNonce:     bigintSchema,
  permitSig:          hexBytesSchema as z.ZodType<`0x${string}`>,
  permitNonce:        bigintSchema,
})

const DepositBodySchema = z.object({
  tokenId:        z.number().int().positive(),
  amount:         bigintSchema,
  networkId:      z.number().int().nonnegative(),
  lzDestId:       z.number().int().nonnegative(),
  lzTokenAmount:  bigintSchema,
  permitNonce:    bigintSchema,
  permitSig:      hexBytesSchema as z.ZodType<`0x${string}`>,
})

const AuthenticateBodySchema = z.object({
  tokenId:        z.number().int().positive(),
  networkId:      z.number().int().nonnegative(),
  lzDestId:       z.number().int().nonnegative(),
  lzTokenAmount:  bigintSchema,
  permitNonce:    bigintSchema,
  permitSig:      hexBytesSchema as z.ZodType<`0x${string}`>,
})

// ─── Helper to get real client IP ────────────────────────────────────────────

function clientIp(req: import('express').Request): string {
  // Express 'trust proxy' is set to 'loopback' in server.ts, so
  // req.ip reflects X-Forwarded-For from nginx faithfully.
  return req.ip ?? 'unknown'
}

// ─── POST /api/sponsor/bootstrap ────────────────────────────────────────────

router.post('/bootstrap', async (req, res) => {
  const service = getSponsorService()
  if (!service) {
    return res.status(503).json({ error: 'SPONSOR_DISABLED', detail: 'Sponsored minting is not enabled on this node' })
  }

  // Rate limit
  const ip = clientIp(req)
  const allowed = await checkSponsorRateLimit(ip, 'bootstrap')
  if (!allowed) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      detail: `Bootstrap limit is ${BOOTSTRAP_RATE_LIMIT} per IP per day`,
    })
  }

  // Validate body
  let params: z.infer<typeof BootstrapBodySchema>
  try {
    params = BootstrapBodySchema.parse(req.body)
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') : String(e)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  // Dispatch
  const result = await service.sponsorBootstrap(params)
  if (isSponsorError(result)) {
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }
  return res.status(200).json(result)
})

// ─── POST /api/sponsor/deposit ───────────────────────────────────────────────

router.post('/deposit', async (req, res) => {
  const service = getSponsorService()
  if (!service) {
    return res.status(503).json({ error: 'SPONSOR_DISABLED', detail: 'Sponsored minting is not enabled on this node' })
  }

  const ip = clientIp(req)
  const allowed = await checkSponsorRateLimit(ip, 'deposit')
  if (!allowed) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      detail: `Deposit limit is ${DEPOSIT_AUTH_RATE_LIMIT} per IP per day`,
    })
  }

  let params: z.infer<typeof DepositBodySchema>
  try {
    params = DepositBodySchema.parse(req.body)
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') : String(e)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  const result = await service.sponsorDeposit(params)
  if (isSponsorError(result)) {
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }
  return res.status(200).json(result)
})

// ─── POST /api/sponsor/authenticate ─────────────────────────────────────────

router.post('/authenticate', async (req, res) => {
  const service = getSponsorService()
  if (!service) {
    return res.status(503).json({ error: 'SPONSOR_DISABLED', detail: 'Sponsored minting is not enabled on this node' })
  }

  const ip = clientIp(req)
  const allowed = await checkSponsorRateLimit(ip, 'authenticate')
  if (!allowed) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      detail: `Authenticate limit is ${DEPOSIT_AUTH_RATE_LIMIT} per IP per day`,
    })
  }

  let params: z.infer<typeof AuthenticateBodySchema>
  try {
    params = AuthenticateBodySchema.parse(req.body)
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') : String(e)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  const result = await service.sponsorAuthenticate(params)
  if (isSponsorError(result)) {
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }
  return res.status(200).json(result)
})

export default router
