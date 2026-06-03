/**
 * validateSponsorCode — gate for /api/sponsor/bootstrap.
 *
 * Checks a caller-supplied invite code against the SponsorCode table and
 * enforces:
 *   - IP-ban after 3 invalid attempts in 24 h
 *   - Global circuit breaker after 1000 invalid responses in 24 h rolling
 *   - Code expiry
 *   - usesRemaining > 0
 *   - deposit amount within the code's maxDepositCawWei cap
 *   - username length >= minUsernameLength
 *   - per-code rate limit: 1 successful lookup per IP per hour
 *
 * Constant-time response on failure (sleeps to a target of ~100 ms) to
 * prevent timing oracles.
 *
 * Redis keys used:
 *   sponsor:cb:lockdown_until          — epoch ms string; circuit-breaker
 *   sponsor:cb:invalid_count            — INCR counter for 24 h window
 *   sponsor:ipban:{ip}                  — exists = banned until key expiry
 *   sponsor:coderate:{codeHash}:{ip}    — per-code per-IP 1/hr rate limit
 */

import Redis from 'ioredis'
import { prisma as _prismaDefault } from '../../prismaClient'
import { hashCode } from '../../services/SponsorService/codes'
import type { SponsorErrorCode } from '../../services/SponsorService'

// Allow tests to inject a mock Prisma client.
let _prismaOverride: typeof _prismaDefault | null = null
export function _setPrismaForTest(p: typeof _prismaDefault | null): void {
  _prismaOverride = p
}
function getPrisma(): typeof _prismaDefault {
  return _prismaOverride ?? _prismaDefault
}

// ─── Redis ────────────────────────────────────────────────────────────────────

const _redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// Allow tests to inject a different Redis instance.
let _redisOverride: Redis | null = null
export function _setRedisForTest(r: Redis | null): void {
  _redisOverride = r
}
function getRedis(): Redis {
  return _redisOverride ?? _redis
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_RESPONSE_MS         = 100   // constant-time sleep target
const INVALID_CODE_LOCKDOWN_THRESHOLD = 1000
const LOCKDOWN_DURATION_MS       = 60 * 60 * 1000   // 1 hour
const IP_BAN_WINDOW_SECONDS      = 24 * 60 * 60      // 24 h
const IP_BAN_THRESHOLD           = 3
const CIRCUIT_WINDOW_SECONDS     = 24 * 60 * 60      // 24 h rolling
const CODE_RATE_WINDOW_SECONDS   = 60 * 60            // 1 h per code per IP

const KEY_LOCKDOWN_UNTIL = 'sponsor:cb:lockdown_until'
const KEY_INVALID_COUNT  = 'sponsor:cb:invalid_count'
const keyIpBan           = (ip: string)                     => `sponsor:ipban:${ip}`
const keyCodeRate        = (codeHash: string, ip: string)   => `sponsor:coderate:${codeHash}:${ip}`
const keyIpAttempts      = (ip: string)                     => `sponsor:ipattempts:${ip}`

// ─── Types ────────────────────────────────────────────────────────────────────

export type CodeValidationErrorCode =
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'CODE_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'IP_BANNED'
  | 'USERNAME_TOO_SHORT'
  | 'DEPOSIT_TOO_LARGE'
  | 'INVALID_CODE_LOCKDOWN'

export interface CodeValidationOk {
  ok: true
  codeHash: string
  /// Phase 2 Sponsor Repay: basis points relative to deposit. 0 = no repay.
  repayBps: number
  /// Phase 2 Sponsor Repay: KYC level required at withdraw. 0 = no KYC.
  requireKycLevel: number
}

export interface CodeValidationFail {
  ok: false
  error: CodeValidationErrorCode
  detail: string
}

export type CodeValidationResult = CodeValidationOk | CodeValidationFail

/**
 * Params subset needed for code validation.
 * Matches the fields from BootstrapBodySchema that the code gate cares about.
 */
export interface CodeValidationParams {
  username: string
  depositAmountCAW: bigint
}

// ─── Per-redemption budget breakdown (USD cents) ─────────────────────────────

export interface RedemptionBudget {
  gasCostUsdCents: number
  netFeesUsdCents: number
  lzFeeUsdCents: number
  depositUsdCents: number
  totalUsdCents: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sleep until `start + TARGET_RESPONSE_MS` ms from when the function was
 * called. Ensures FAILED responses always take ~100ms regardless of DB speed.
 */
async function sleepToTarget(startMs: number): Promise<void> {
  const elapsed = Date.now() - startMs
  const remaining = TARGET_RESPONSE_MS - elapsed
  if (remaining > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, remaining))
  }
}

/**
 * Increment the global invalid-code counter for the circuit breaker.
 * Returns the new count. Fails silently on Redis error.
 */
async function incrementInvalidCount(): Promise<number> {
  try {
    const redis = getRedis()
    const count = await redis.incr(KEY_INVALID_COUNT)
    if (count === 1) {
      await redis.expire(KEY_INVALID_COUNT, CIRCUIT_WINDOW_SECONDS)
    }
    return count
  } catch {
    return 0
  }
}

/**
 * Check whether the circuit breaker is currently tripped.
 */
async function isCircuitBreakerActive(): Promise<boolean> {
  try {
    const redis = getRedis()
    const val = await redis.get(KEY_LOCKDOWN_UNTIL)
    if (!val) return false
    return Date.now() < Number(val)
  } catch {
    return false
  }
}

/**
 * Trip the circuit breaker for LOCKDOWN_DURATION_MS.
 */
async function tripCircuitBreaker(): Promise<void> {
  try {
    const redis = getRedis()
    const until = Date.now() + LOCKDOWN_DURATION_MS
    // SET NX so a concurrent trip doesn't extend the window.
    await redis.set(KEY_LOCKDOWN_UNTIL, String(until), 'EX', Math.ceil(LOCKDOWN_DURATION_MS / 1000), 'NX')
  } catch {
    // Ignore
  }
}

/**
 * Record an invalid-code attempt for the given IP in both:
 *   - Redis (fast per-IP ban check)
 *   - DB  (SponsorCodeAttempt, for audit and persistent window if Redis restarts)
 * Returns the updated attempt count in the 24 h window.
 */
async function recordInvalidAttempt(ip: string): Promise<number> {
  // Redis counter for the fast-path ban check.
  let count = 0
  try {
    const redis = getRedis()
    count = await redis.incr(keyIpAttempts(ip))
    if (count === 1) {
      await redis.expire(keyIpAttempts(ip), IP_BAN_WINDOW_SECONDS)
    }
  } catch {
    // Fall back to DB count below.
  }

  // DB row for audit log.
  try {
    await getPrisma().sponsorCodeAttempt.create({ data: { ip } })
    if (count === 0) {
      // Redis was unavailable; count from DB.
      const since = new Date(Date.now() - IP_BAN_WINDOW_SECONDS * 1000)
      count = await getPrisma().sponsorCodeAttempt.count({
        where: { ip, attemptedAt: { gte: since } },
      })
    }
  } catch {
    // DB write failed — use Redis count.
  }

  return count
}

/**
 * Check whether the IP is currently banned.
 */
async function isIpBanned(ip: string): Promise<boolean> {
  try {
    const redis = getRedis()
    const banned = await redis.exists(keyIpBan(ip))
    if (banned) return true
  } catch {
    // Fall back to DB.
  }
  // Fast DB check: >= IP_BAN_THRESHOLD attempts in last 24 h.
  try {
    const since = new Date(Date.now() - IP_BAN_WINDOW_SECONDS * 1000)
    const count = await getPrisma().sponsorCodeAttempt.count({
      where: { ip, attemptedAt: { gte: since } },
    })
    return count >= IP_BAN_THRESHOLD
  } catch {
    return false
  }
}

/**
 * Set the IP ban key in Redis (TTL = 24 h).
 */
async function banIp(ip: string): Promise<void> {
  try {
    const redis = getRedis()
    await redis.set(keyIpBan(ip), '1', 'EX', IP_BAN_WINDOW_SECONDS)
  } catch {
    // Ignore; DB-based fallback in isIpBanned covers this.
  }
}

/**
 * Check the per-code per-IP rate limit (1 lookup per hour).
 * Returns true if allowed (under limit), false if exceeded.
 */
async function checkCodeRateLimit(codeHash: string, ip: string): Promise<boolean> {
  try {
    const redis = getRedis()
    const key = keyCodeRate(codeHash, ip)
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, CODE_RATE_WINDOW_SECONDS)
    }
    return count <= 1  // 1 per hour
  } catch {
    return true  // fail open
  }
}

// ─── Budget computation ───────────────────────────────────────────────────────

/**
 * Compute the per-redemption USD cost breakdown from current prices and
 * on-chain fee estimates. Uses the in-process price cache from ChainSyncService.
 *
 * All values are in USD cents (integers).
 * Returns null if price data is unavailable.
 */
export function computeRedemptionBudget(opts: {
  gasPriceWei: bigint
  gasLimitBootstrap: bigint
  netFeesWei: bigint
  lzFeeWei: bigint
  depositAmountCAW: bigint
  ethUsdCents: number    // current ETH price in USD cents
  cawUsdCents: number    // current CAW price in USD cents (fractional, e.g. 0.0001)
}): RedemptionBudget {
  const ETH_WEI = 10n ** 18n

  // Gas cost: gasPrice * gasLimit in ETH, convert to USD cents.
  const gasCostWei  = opts.gasPriceWei * opts.gasLimitBootstrap
  const gasCostUsdCents = Number(gasCostWei * BigInt(opts.ethUsdCents) / ETH_WEI)

  // Network fees (mintFee×2 + authFee×2 + depositFee×2) in USD cents.
  const netFeesUsdCents = Number(opts.netFeesWei * BigInt(opts.ethUsdCents) / ETH_WEI)

  // LayerZero fee in USD cents.
  const lzFeeUsdCents = Number(opts.lzFeeWei * BigInt(opts.ethUsdCents) / ETH_WEI)

  // Deposit cost: depositAmountCAW * cawUsdCents (CAW in 1e18 wei).
  // cawUsdCents is already fractional (e.g., 0.0001 cents per 1 CAW token).
  // We scale to avoid floating-point loss.
  // depositAmountCAW is in 1e18 units, so divide by 1e18 first.
  const depositTokens   = Number(opts.depositAmountCAW) / 1e18
  const depositUsdCents = Math.round(depositTokens * opts.cawUsdCents)

  const totalUsdCents = gasCostUsdCents + netFeesUsdCents + lzFeeUsdCents + depositUsdCents

  return {
    gasCostUsdCents,
    netFeesUsdCents,
    lzFeeUsdCents,
    depositUsdCents,
    totalUsdCents,
  }
}

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * Validate a sponsor code before calling sponsorBootstrap.
 *
 * Constant-time on failure: sleeps until TARGET_RESPONSE_MS ms total elapsed.
 * On success, returns the codeHash so the caller can commit the redemption.
 *
 * @param rawCode   The raw code string supplied by the caller.
 * @param params    Bootstrap params (username + depositAmountCAW used for checks).
 * @param ip        The caller's IP address (from req.ip).
 * @param budget    Optional pre-computed budget breakdown. If provided and
 *                  total > code.budgetCapUsdCents, returns BUDGET_EXCEEDED.
 */
export async function validateSponsorCode(
  rawCode: string,
  params: CodeValidationParams,
  ip: string,
  budget?: RedemptionBudget,
): Promise<CodeValidationResult> {
  const startMs = Date.now()

  // ── 1. Circuit breaker ────────────────────────────────────────────────────
  if (await isCircuitBreakerActive()) {
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'INVALID_CODE_LOCKDOWN',
      detail: 'Sponsor code endpoint is temporarily locked due to excessive invalid attempts. Try again later.',
    }
  }

  // ── 2. IP ban check ───────────────────────────────────────────────────────
  if (await isIpBanned(ip)) {
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'IP_BANNED',
      detail: 'This IP has been temporarily banned due to excessive invalid code attempts.',
    }
  }

  // ── 3. Hash the code ──────────────────────────────────────────────────────
  let codeHash: string
  try {
    codeHash = hashCode(rawCode)
  } catch (e) {
    // HMAC secret not set — configuration error.
    await sleepToTarget(startMs)
    return { ok: false, error: 'INVALID_CODE', detail: 'Code validation unavailable (misconfigured).' }
  }

  // ── 4. DB lookup (constant-time via hash) ──────────────────────────────────
  const code = await getPrisma().sponsorCode.findUnique({ where: { codeHash } })

  if (!code) {
    const attempts = await recordInvalidAttempt(ip)
    const count = await incrementInvalidCount()
    if (count >= INVALID_CODE_LOCKDOWN_THRESHOLD) {
      await tripCircuitBreaker()
    }
    if (attempts >= IP_BAN_THRESHOLD) {
      await banIp(ip)
      await sleepToTarget(startMs)
      return {
        ok: false,
        error: 'IP_BANNED',
        detail: 'This IP has been banned due to too many invalid code attempts.',
      }
    }
    await sleepToTarget(startMs)
    return { ok: false, error: 'INVALID_CODE', detail: 'Invite code not found or invalid.' }
  }

  // ── 5. Per-code per-IP rate limit (1/hour) ─────────────────────────────────
  const rateOk = await checkCodeRateLimit(codeHash, ip)
  if (!rateOk) {
    // Not an "invalid code" — don't increment the ban counter.
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'INVALID_CODE',
      detail: 'Too many attempts with this code from your IP. Try again in an hour.',
    }
  }

  // ── 6. Expiry ──────────────────────────────────────────────────────────────
  if (code.expiresAt < new Date()) {
    await sleepToTarget(startMs)
    return { ok: false, error: 'CODE_EXPIRED', detail: 'This invite code has expired.' }
  }

  // ── 7. Uses remaining ─────────────────────────────────────────────────────
  if (code.usesRemaining !== null && code.usesRemaining <= 0) {
    await sleepToTarget(startMs)
    return { ok: false, error: 'CODE_EXHAUSTED', detail: 'This invite code has no uses remaining.' }
  }

  // ── 8. Max deposit CAW check ───────────────────────────────────────────────
  const maxDepositWei = BigInt(code.maxDepositCawWei)
  if (params.depositAmountCAW > maxDepositWei) {
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'DEPOSIT_TOO_LARGE',
      detail: `Requested deposit exceeds this code's maximum (${code.maxDepositCawWei} wei).`,
    }
  }

  // ── 9. Username length check ──────────────────────────────────────────────
  if (code.minUsernameLength > 0 && params.username.length < code.minUsernameLength) {
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'USERNAME_TOO_SHORT',
      detail: `Username must be at least ${code.minUsernameLength} characters for this invite code.`,
    }
  }

  // ── 10. Budget cap check ──────────────────────────────────────────────────
  if (budget && budget.totalUsdCents > code.budgetCapUsdCents) {
    await sleepToTarget(startMs)
    return {
      ok: false,
      error: 'BUDGET_EXCEEDED',
      detail: `Estimated redemption cost ($${(budget.totalUsdCents / 100).toFixed(2)}) exceeds code budget cap ($${(code.budgetCapUsdCents / 100).toFixed(2)}).`,
    }
  }

  // All checks passed — success (no sleep needed, the DB round-trip takes ~10ms)
  return {
    ok: true,
    codeHash,
    repayBps:        code.repayBps ?? 0,
    requireKycLevel: code.requireKycLevel ?? 0,
  }
}

/**
 * Commit a successful redemption atomically:
 *   1. Decrement usesRemaining (if not null).
 *   2. Insert SponsorRedemption row.
 *
 * Uses two independent Prisma writes per the two-tx split pattern
 * (feedback_two_tx_split_pattern.md): the fact row (SponsorCode update)
 * commits independently from the derived row (SponsorRedemption).
 * Both are best-effort; a failure here is logged but does NOT roll back
 * the already-submitted on-chain transaction.
 */
export async function commitRedemption(opts: {
  codeHash: string
  recipient: string
  txHash: string | null
  budget: RedemptionBudget
}): Promise<void> {
  // Tx 1: decrement usesRemaining if the code has a limit.
  try {
    await getPrisma().sponsorCode.updateMany({
      where: {
        codeHash: opts.codeHash,
        usesRemaining: { gt: 0 },
      },
      data: {
        usesRemaining: { decrement: 1 },
      },
    })
  } catch (err) {
    console.error('[validateSponsorCode] Failed to decrement usesRemaining:', err)
  }

  // Tx 2: insert redemption audit row.
  try {
    await getPrisma().sponsorRedemption.create({
      data: {
        codeHash: opts.codeHash,
        recipient: opts.recipient,
        txHash: opts.txHash,
        gasCostUsdCents: opts.budget.gasCostUsdCents,
        netFeesUsdCents: opts.budget.netFeesUsdCents,
        lzFeeUsdCents:   opts.budget.lzFeeUsdCents,
        depositUsdCents: opts.budget.depositUsdCents,
        totalUsdCents:   opts.budget.totalUsdCents,
      },
    })
  } catch (err) {
    console.error('[validateSponsorCode] Failed to insert SponsorRedemption:', err)
  }
}
