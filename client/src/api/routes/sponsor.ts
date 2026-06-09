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
import { prisma } from '../../prismaClient'
import {
  getSponsorService,
  isSponsorError,
} from '../../services/SponsorService'
import {
  validateSponsorCode,
  commitRedemption,
  computeRedemptionBudget,
} from '../middleware/validateSponsorCode'
import { getCawPriceCache, getEthPriceCache } from '../../services/ChainSyncService'
import { hashCode } from '../../services/SponsorService/codes'

const router = Router()

// ─── Redis for rate limiting ─────────────────────────────────────────────────

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// ─── Rate limit helpers ──────────────────────────────────────────────────────

const BOOTSTRAP_RATE_LIMIT     = 3
const DEPOSIT_AUTH_RATE_LIMIT  = 30
const RATE_WINDOW_SECONDS      = 24 * 60 * 60   // 24 hours

// Code-info: 30 lookups per IP per 10 minutes
const CODE_INFO_RATE_LIMIT     = 30
const CODE_INFO_WINDOW_SECONDS = 10 * 60         // 10 minutes

// Gas limit for bootstrap tx — mirrors the constant in SponsorService/index.ts.
// Used in the per-redemption budget computation.
const GAS_LIMIT_BOOTSTRAP_BUDGET = 400_000n

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

/**
 * Per-IP rate limit for GET /api/sponsor/code/:code.
 * Returns true if allowed. Always does the DB lookup regardless (timing uniformity).
 * On exceed returns false — caller responds { valid: false } (200, not 429) so
 * the rate limiter itself is not a distinguishing oracle.
 */
async function checkCodeInfoRateLimit(ip: string): Promise<boolean> {
  const key = `sponsor:codeinfo:${ip}`
  try {
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, CODE_INFO_WINDOW_SECONDS)
    } else {
      const ttl = await redis.ttl(key)
      if (ttl < 0) await redis.expire(key, CODE_INFO_WINDOW_SECONDS)
    }
    return count <= CODE_INFO_RATE_LIMIT
  } catch {
    return true  // fail open
  }
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex')
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be 0x-prefixed 20-byte address')
// Signature-specific schema (L-2): 65-byte ECDSA = 132 chars. WebAuthn blobs are
// larger (encodes authenticatorData + clientDataJSON + r + s as bytes, bytes,
// bytes32, bytes32) — typically <1500 bytes. Cap at ~8 KB with margin for any
// reasonable WebAuthn payload. Multi-MB hex payloads are never valid and would
// let a caller fill the request body parser up to its limit on every call.
const sigHexSchema = z.string()
  .regex(/^0x[0-9a-fA-F]+$/, 'must be 0x-prefixed hex')
  .refine(s => s.length % 2 === 0, 'odd-length hex')
  .refine(s => s.length <= 8194, 'sig too long; max 8194 chars (~4 KB)')
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
  ecdsaFallbackAddr:  (addressSchema.refine(
    v => v.toLowerCase() !== '0x0000000000000000000000000000000000000000',
    { message: 'ecdsaFallbackAddr cannot be zero address' },
  ) as z.ZodType<`0x${string}`>),
  // L-3: mirror the contract's isValidUsername constraint ([a-z0-9], 1-32 chars)
  // to fail-fast before spending any RPC calls or gas.
  username:           z.string().min(1).max(32).regex(/^[a-z0-9]+$/, 'username must be lowercase alphanumeric only'),
  depositAmountCAW:   bigintSchema,
  networkId:          z.number().int().nonnegative(),
  lzDestId:           z.number().int().nonnegative(),
  lzTokenAmount:      bigintSchema,
  authTupleSignature: authTupleSignatureSchema,
  authTupleNonce:     bigintSchema,
  permitSig:          sigHexSchema as z.ZodType<`0x${string}`>,  // L-2: cap at 8 KB
  permitNonce:        bigintSchema,
  // Invite code — required; without a valid code the bootstrap is rejected.
  code:               z.string().min(8).max(64),
  // Sponsor-Repay (Phase 2): the repayAmount the FE computed and SIGNED into
  // the permit digest. Optional (absent = plain gift, signed repayAmount 0).
  // The server recomputes the authoritative value from the code and rejects
  // early on mismatch — this is a UX guard so the user gets a clean error
  // instead of an opaque on-chain ERC-1271 failure, NOT a trust boundary
  // (the on-chain call always uses the server's code-derived value).
  signedRepayAmount:  bigintSchema.optional(),
})

const DepositBodySchema = z.object({
  tokenId:        z.number().int().positive(),
  amount:         bigintSchema,
  networkId:      z.number().int().nonnegative(),
  lzDestId:       z.number().int().nonnegative(),
  lzTokenAmount:  bigintSchema,
  permitNonce:    bigintSchema,
  permitSig:      sigHexSchema as z.ZodType<`0x${string}`>,  // L-2: cap at 8 KB
})

const AuthenticateBodySchema = z.object({
  tokenId:        z.number().int().positive(),
  networkId:      z.number().int().nonnegative(),
  lzDestId:       z.number().int().nonnegative(),
  lzTokenAmount:  bigintSchema,
  permitNonce:    bigintSchema,
  permitSig:      sigHexSchema as z.ZodType<`0x${string}`>,  // L-2: cap at 8 KB
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

  // Rate limit (L-1): intentionally checked BEFORE sig verification. This means
  // a legitimate user with a typo'd sig will consume one quota slot on each
  // failed attempt. The trade-off is deliberate: checking rate limits first
  // prevents probing attacks where an adversary burns through sig verification
  // CPU (or on-chain simulation budget) before the quota fires. A user who
  // typo'd their sig gets a correct error on the next attempt (within their
  // remaining quota) — acceptable UX for a 3/day operation.
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
    // Log the rejection so the reason is visible server-side — the FE only
    // surfaces a generic "HTTP 400" to the user, so without this a malformed
    // bootstrap payload is a black box from the operator's side.
    console.warn(`[sponsor/bootstrap] 400 VALIDATION from ${ip}: ${detail}`)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  // ── Sponsor-code gate ─────────────────────────────────────────────────────
  // Compute a best-effort budget breakdown from cached price data.
  // If prices are unavailable we still allow the request through the budget
  // check (budget=undefined), but the code's usesRemaining and maxDeposit
  // guards still apply.
  let budget: ReturnType<typeof computeRedemptionBudget> | undefined
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()
  if (cawPrice && ethPrice) {
    // ethUsdCents: usdPerEth is in units of 1e6 (6 decimal places) per
    // ChainSyncService. Convert to cents (multiply by 100, divide by 1e6 = /1e4).
    const ethUsdCents = Number(ethPrice.usdPerEth) / 1e4
    // cawUsdCents: ethPerCaw is in 1e18 units (wei per 1 CAW), convert to USD cents.
    const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
    const cawUsdCents = ethPerCawFloat * ethUsdCents
    // Approximate gas price: use 20 gwei as a safe upper bound when we don't
    // have a live estimate (avoids an RPC call per request per the no-RPC rule).
    const gasPriceWei = 20_000_000_000n  // 20 gwei
    budget = computeRedemptionBudget({
      gasPriceWei,
      gasLimitBootstrap: GAS_LIMIT_BOOTSTRAP_BUDGET,
      // netFees: 2×(mintFee + authFee + depositFee). Approximate with 0.003 ETH
      // as a safe upper bound since we don't want to do an RPC call here.
      netFeesWei: 3_000_000_000_000_000n,  // 0.003 ETH
      lzFeeWei: params.lzTokenAmount,
      depositAmountCAW: params.depositAmountCAW,
      ethUsdCents,
      cawUsdCents,
    })
  }

  const codeValidation = await validateSponsorCode(
    params.code,
    { username: params.username, depositAmountCAW: params.depositAmountCAW },
    ip,
    budget,
  )
  if (!codeValidation.ok) {
    const statusMap: Record<string, number> = {
      INVALID_CODE_LOCKDOWN: 503,
      IP_BANNED: 403,
      BUDGET_EXCEEDED: 400,
      CODE_EXPIRED: 400,
      CODE_EXHAUSTED: 400,
      DEPOSIT_TOO_LARGE: 400,
      USERNAME_TOO_SHORT: 400,
      INVALID_CODE: 400,
    }
    const status = statusMap[codeValidation.error] ?? 400
    return res.status(status).json({ error: codeValidation.error, detail: codeValidation.detail })
  }

  // ── Phase 2 Sponsor Repay derivation ──────────────────────────────────────
  // The sponsor-code policy (set by admin at code creation) drives both the
  // repay obligation (repayBps) and any KYC gate (requireKycLevel). When
  // both are zero, the call is byte-identical to the pre-Phase-2 flow.
  let repayAmount = 0n
  let sponsorTokenId = 0
  if (codeValidation.repayBps > 0) {
    repayAmount = (params.depositAmountCAW * BigInt(codeValidation.repayBps)) / 10000n
    // Contract enforces repayAmount <= depositAmount * 2; mirror that check
    // here so the user gets a clean error instead of an on-chain revert.
    if (repayAmount > params.depositAmountCAW * 2n) {
      return res.status(400).json({
        error: 'VALIDATION',
        detail: `Computed repayAmount exceeds the 2x deposit cap (repayBps=${codeValidation.repayBps}).`,
      })
    }
    const envSponsorId = Number(process.env.PLATFORM_SPONSOR_TOKEN_ID ?? 1)
    sponsorTokenId = Number.isInteger(envSponsorId) && envSponsorId > 0 ? envSponsorId : 1
  }

  // UX guard: if the FE told us what repayAmount it signed, confirm it matches
  // the authoritative server-derived value. On mismatch the permit digest would
  // fail the on-chain ERC-1271 check (opaque MinterCallFailed) — fail early with
  // a clear error instead. Absent signedRepayAmount = legacy plain-gift FE; the
  // signed value is 0, which only matches when repayAmount is also 0.
  const signedRepay = params.signedRepayAmount ?? 0n
  if (signedRepay !== repayAmount) {
    return res.status(400).json({
      error: 'REPAY_MISMATCH',
      detail: `Signed repayAmount (${signedRepay}) does not match the code's policy ` +
        `(${repayAmount}). Refresh and retry — the invite code's repay terms may have changed.`,
    })
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  const result = await service.sponsorBootstrap({
    ...params,
    kycLevel:       codeValidation.requireKycLevel,
    sponsorTokenId,
    repayAmount,
  })
  if (isSponsorError(result)) {
    // Bootstrap failed — do NOT decrement usesRemaining (caller can retry).
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }

  // Success: commit the redemption audit row asynchronously.
  // We fire-and-forget so a DB hiccup doesn't break the user's UX.
  // The txHash is available; recipient is recovered from the auth tuple
  // during sponsorBootstrap (we don't re-derive it here — the service
  // doesn't expose the recovered address yet, so we use an empty string
  // as a placeholder for now and can backfill from on-chain if needed).
  commitRedemption({
    codeHash: codeValidation.codeHash,
    recipient: '',  // TODO: expose recovered EOA from SponsorService.sponsorBootstrap
    txHash: result.txHash,
    budget: budget ?? {
      gasCostUsdCents: 0,
      netFeesUsdCents: 0,
      lzFeeUsdCents: 0,
      depositUsdCents: 0,
      totalUsdCents: 0,
    },
  }).catch(err => console.error('[sponsor] commitRedemption failed:', err))

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

// Named exports for test-only schema access (L-3 validation tests)
export { BootstrapBodySchema }

// ─── Sponsor Repay read-only status ──────────────────────────────────────────
// Public DB read. Returns the on-chain repay obligation for a given recipient
// tokenId. Written exclusively by SponsorRepayIndexer + ChainSyncService from
// L1+L2 events; never by API handlers. 404 when no row (no repay declared).
//
// Per project_no_rpc_in_request_handlers: this is a DB-only read; no RPC.
router.get('/repay/:tokenId', async (req, res) => {
  const tokenIdNum = Number(req.params.tokenId)
  if (!Number.isInteger(tokenIdNum) || tokenIdNum < 0 || tokenIdNum > 0xFFFFFFFF) {
    return res.status(400).json({ error: 'INVALID_TOKEN_ID' })
  }

  try {
    const row = await prisma.sponsorRepay.findUnique({ where: { tokenId: tokenIdNum } })
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' })

    // Resolve sponsor's username for FE display. tokenId == User.id in the
    // schema (User.id is set to tokenId at creation). Tolerate missing.
    const sponsor = await prisma.user.findUnique({
      where: { id: row.sponsorTokenId },
      select: { username: true },
    }).catch(() => null)

    return res.status(200).json({
      tokenId:                row.tokenId,
      sponsorTokenId:         row.sponsorTokenId,
      sponsorUsername:        sponsor?.username ?? null,
      currentRepayAmountWei:  row.currentRepayAmount,
      originalRepayAmountWei: row.originalRepayAmount,
      sponsoredDepositWei:    row.sponsoredDepositAmount,
      registeredAt:           row.registeredAt,
      forgivenAt:             row.forgivenAt,
      lastSweepAmountWei:     row.lastSweepAmount,
      lastSweepAt:            row.lastSweepAt,
    })
  } catch (err: any) {
    console.error('[/sponsor/repay] error:', err?.message)
    return res.status(500).json({ error: 'INTERNAL' })
  }
})

// ─── GET /api/sponsor/code/:code ─────────────────────────────────────────────
// Read-only invite-code info for FE onboarding pre-flight.
// Always returns HTTP 200 — never 404 — so the status code itself is not an
// oracle for whether a code exists.
//
// Valid:   { valid: true,  giftCaw: "<wei string>", minUsernameLength: N, expiresAt: "<ISO>" }
// Invalid: { valid: false }
//
// Anti-abuse: 30 lookups / IP / 10 min (Redis). On exceed: { valid: false }
// (200) — the rate limiter is not a distinguishing signal. DB lookup runs
// unconditionally for timing uniformity.
router.get('/code/:code', async (req, res) => {
  const ip = clientIp(req)
  const allowed = await checkCodeInfoRateLimit(ip)

  // Hash the raw code unconditionally — runs even on rate-limit so timing is
  // similar whether or not the limit has fired.
  let codeHash: string
  try {
    codeHash = hashCode(req.params.code)
  } catch {
    // SPONSOR_CODE_HMAC_SECRET not set — treat as invalid, same as not found.
    return res.status(200).json({ valid: false })
  }

  // DB lookup runs unconditionally for timing uniformity.
  const code = await prisma.sponsorCode.findUnique({ where: { codeHash } }).catch(() => null)

  if (!allowed) {
    return res.status(200).json({ valid: false })
  }

  const now = new Date()
  const isValid =
    code !== null &&
    code.expiresAt > now &&
    (code.usesRemaining === null || code.usesRemaining > 0)

  if (!isValid) {
    return res.status(200).json({ valid: false })
  }

  // Sponsor-Repay (Phase 2) disclosure. `repayBps` lets the FE compute the
  // exact repayAmount it must sign over — the digest MUST match what the server
  // passes to mintAndDepositSponsored (the server recomputes the same value
  // from the same code below; a mismatch fails the on-chain ERC-1271 check).
  // sponsorTokenId is the profile that collects repayments (PLATFORM_SPONSOR_
  // TOKEN_ID, default 1 = the operator's own profile). Both surfaced so the
  // onboarding UI can disclose the repay terms before the user signs.
  const repayBps = code.repayBps ?? 0
  const sponsorTokenId = repayBps > 0
    ? (() => {
        const envId = Number(process.env.PLATFORM_SPONSOR_TOKEN_ID ?? 1)
        return Number.isInteger(envId) && envId > 0 ? envId : 1
      })()
    : 0

  return res.status(200).json({
    valid: true,
    giftCaw: code.maxDepositCawWei,
    minUsernameLength: code.minUsernameLength,
    expiresAt: code.expiresAt.toISOString(),
    repayBps,
    sponsorTokenId,
  })
})

export default router
