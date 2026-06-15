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
import { quoteSponsorInviteCostCaw, quoteExecuteGasFeeCaw } from '../../services/SponsorService/inviteQuote'
import { CAW_ADDRESS } from '../../abi/addresses'
import { getOwnValidatorTokenId } from '../../services/SponsorService/validatorIdentity'
import { decryptInviteCode } from '../../services/SponsorService/inviteCodeCrypto'
import { requireAuth } from '../middleware/auth'
import { consumeXQualifiedToken } from './xSignup'

const router = Router()

// ─── Redis for rate limiting ─────────────────────────────────────────────────

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({ port: 6379, host: '127.0.0.1' })

// ─── Rate limit helpers ──────────────────────────────────────────────────────

const BOOTSTRAP_RATE_LIMIT     = 5    // accounts CREATED per IP per day
const DEPOSIT_AUTH_RATE_LIMIT  = 30
const RATE_WINDOW_SECONDS      = 24 * 60 * 60   // 24 hours

// Ungated (no invite code, no X) zero-deposit signups. Independent counter +
// independent opt-in so a flood of free-profile attempts can NEVER trip or
// exhaust the invite-code path's quota/budget. Off unless the operator sets
// SPONSOR_UNGATED_ENABLED=true. Lower cap than the gifted path on purpose.
const UNGATED_ENABLED          = process.env.SPONSOR_UNGATED_ENABLED === 'true'
const UNGATED_RATE_LIMIT       = Number(process.env.SPONSOR_UNGATED_RATE_LIMIT ?? 3)

// Code-info: 30 lookups per IP per 10 minutes
const CODE_INFO_RATE_LIMIT     = 30
const CODE_INFO_WINDOW_SECONDS = 10 * 60         // 10 minutes

// Gas limit for bootstrap tx — mirrors the constant in SponsorService/index.ts.
// Used in the per-redemption budget computation.
const GAS_LIMIT_BOOTSTRAP_BUDGET = 400_000n

/**
 * PEEK-ONLY per-IP limiter. Returns true if the IP is UNDER the limit, false if
 * at/over. Does NOT increment — a failed/abandoned attempt must not consume a
 * slot. The slot is only spent on actual success via recordSponsorUse() below.
 *
 * Rationale (updated): now that bootstrap invite codes are user-PURCHASED (each
 * already cost the buyer CAW that covers the validator's gas), the IP gate is a
 * coarse anti-flood backstop, not the primary economic control. So we (a) count
 * only accounts actually CREATED, not every attempt — a typo'd sig no longer
 * burns a slot — and (b) allow up to BOOTSTRAP_RATE_LIMIT creations/IP/day.
 *
 * Still checked BEFORE sig verification (peek is cheap) so a probing attacker at
 * the cap is rejected before any sig/sim work — but the peek doesn't consume.
 * Fails open on Redis error (same pattern as freeActionRateLimit.ts).
 */
async function checkSponsorRateLimit(ip: string, op: 'bootstrap' | 'deposit' | 'authenticate' | 'ungated'): Promise<boolean> {
  const limit = op === 'bootstrap' ? BOOTSTRAP_RATE_LIMIT
    : op === 'ungated' ? UNGATED_RATE_LIMIT
    : DEPOSIT_AUTH_RATE_LIMIT
  const key = `sponsor:${op}:${ip}`
  try {
    const raw = await redis.get(key)
    const count = raw ? parseInt(raw, 10) : 0
    return count < limit
  } catch {
    // Gated paths (bootstrap/deposit/authenticate) carry their own economic
    // backstop — an invite code costs CAW, an X token is single-use — so they
    // fail OPEN (a Redis blip shouldn't break a paid signup). The ungated free
    // path has NO such backstop, so a Redis outage would otherwise be an
    // unbounded free-mint hole that drains the sponsor; it fails CLOSED. (#229)
    return op !== 'ungated'
  }
}

/**
 * Record one successful sponsored op against an IP's daily quota. Call ONLY
 * after the account/op actually succeeded. Sets the 24h TTL on first use.
 */
async function recordSponsorUse(ip: string, op: 'bootstrap' | 'deposit' | 'authenticate' | 'ungated'): Promise<void> {
  const key = `sponsor:${op}:${ip}`
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, RATE_WINDOW_SECONDS)
    else {
      const ttl = await redis.ttl(key)
      if (ttl < 0) await redis.expire(key, RATE_WINDOW_SECONDS)
    }
  } catch (err) {
    // Best-effort: a Redis hiccup means this use won't count against the IP's
    // daily quota — but the op already succeeded, so we never surface this to the
    // user. Log it so a persistently-broken counter (quotas silently not
    // enforced) is at least visible to the operator.
    console.warn(`[sponsor] recordSponsorUse(${op}) failed; quota not incremented:`, (err as any)?.message ?? err)
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
  // Gate (exactly one required): either an invite `code` OR an
  // `xQualifiedToken` from the open X-signup flow (/api/verify/x/signup-*).
  // Both optional at the schema level; the handler enforces exactly-one and
  // rejects if neither is present.
  code:               z.string().min(8).max(64).optional(),
  // X-qualified token (base64url, 24 random bytes → 32 chars). Issued by
  // /api/verify/x/signup-callback after age>90d-OR-verified passes. Consumed
  // (burned) here; the WalletXLink written post-mint permanently spends the X id.
  xQualifiedToken:    z.string().min(16).max(128).optional(),
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

  const ip = clientIp(req)

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

  // ── Gate: a sponsor code, an X-qualified token, OR (if enabled) neither ─────
  // Three valid shapes: (1) invite code → gifted deposit; (2) X-qualified token →
  // gifted deposit; (3) UNGATED — no code, no X → a free zero-deposit profile,
  // only when SPONSOR_UNGATED_ENABLED. "Both present" is always rejected (the
  // FE never sends both; it signals a confused/forged request).
  const hasCode = typeof params.code === 'string' && params.code.length > 0
  const hasXToken = typeof params.xQualifiedToken === 'string' && params.xQualifiedToken.length > 0
  const isUngated = !hasCode && !hasXToken
  if (hasCode && hasXToken) {
    return res.status(400).json({
      error: 'GATE_REQUIRED',
      detail: 'Provide at most one of: a sponsor `code`, or an `xQualifiedToken` from X signup.',
    })
  }
  if (isUngated && !UNGATED_ENABLED) {
    return res.status(400).json({
      error: 'GATE_REQUIRED',
      detail: 'An invite code or X verification is required to create an account here.',
    })
  }

  // Rate limit: PEEK-only here. The ungated (free) path uses an INDEPENDENT
  // counter + cap so a flood of free signups can never trip or exhaust the
  // invite-code path's quota. The slot is spent only on an actual account
  // creation via recordSponsorUse() at the success path — abandoned/typo'd
  // attempts never burn quota.
  const rateOp = isUngated ? 'ungated' : 'bootstrap'
  const allowed = await checkSponsorRateLimit(ip, rateOp)
  if (!allowed) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      detail: isUngated
        ? `Free signup limit is ${UNGATED_RATE_LIMIT} per IP per day. Try an invite code.`
        : `Bootstrap limit is ${BOOTSTRAP_RATE_LIMIT} per IP per day`,
    })
  }

  // Downstream values both gates must produce. Defaults = plain gift, no repay,
  // no KYC. The code path may override repay/KYC; the X path keeps the defaults.
  let repayAmount = 0n
  let sponsorTokenId = 0
  let kycLevel = 0
  let codeHash: string | null = null
  // X-gate: set when the request authenticates via an X-qualified token so the
  // post-mint step can write the WalletXLink that burns this X id's free mint.
  let xGate: { xUserId: string; xHandle: string } | null = null

  // Budget breakdown (best-effort from cached prices) — used by the code gate's
  // budget guard and the redemption audit row. Computed for both paths.
  let budget: ReturnType<typeof computeRedemptionBudget> | undefined
  const cawPrice = getCawPriceCache()
  const ethPrice = getEthPriceCache()
  if (cawPrice && ethPrice) {
    const ethUsdCents = Number(ethPrice.usdPerEth) / 1e4
    const ethPerCawFloat = Number(cawPrice.ethPerCaw) / 1e18
    const cawUsdCents = ethPerCawFloat * ethUsdCents
    const gasPriceWei = 20_000_000_000n  // 20 gwei
    budget = computeRedemptionBudget({
      gasPriceWei,
      gasLimitBootstrap: GAS_LIMIT_BOOTSTRAP_BUDGET,
      netFeesWei: 3_000_000_000_000_000n,  // 0.003 ETH
      lzFeeWei: params.lzTokenAmount,
      depositAmountCAW: params.depositAmountCAW,
      ethUsdCents,
      cawUsdCents,
    })
  }

  if (hasXToken) {
    // ── X-qualified token gate (open signup) ────────────────────────────────
    // Consume (burn) the token issued by /api/verify/x/signup-callback. It is
    // single-use; a replay finds nothing. The X account already passed
    // age>90d-OR-verified + not-already-linked at issue time. Repay/KYC stay 0
    // (plain gift), so signedRepayAmount must be 0 — enforced below.
    const consumed = await consumeXQualifiedToken(params.xQualifiedToken!)
    if (!consumed) {
      return res.status(400).json({
        error: 'X_TOKEN_INVALID',
        detail: 'X verification expired or already used. Re-verify your X account.',
      })
    }
    xGate = consumed
  } else if (isUngated) {
    // ── Ungated free signup (no code, no X) ─────────────────────────────────
    // Reached only when SPONSOR_UNGATED_ENABLED (asserted above). The server
    // fronts the burn-cost CAW + LZ gas for a ZERO-deposit profile: the user
    // gets a name + NFT but no staked CAW (they fund it later via /wallet). We
    // force depositAmountCAW=0 here so a forged large-deposit body can't make
    // the validator front a gifted balance on the free path. repay/KYC stay 0.
    if (params.depositAmountCAW !== 0n) {
      return res.status(400).json({
        error: 'UNGATED_DEPOSIT_FORBIDDEN',
        detail: 'Free (ungated) signups must request a zero deposit. Fund your wallet after signup.',
      })
    }
  } else {
    // ── Sponsor-code gate ───────────────────────────────────────────────────
    const codeValidation = await validateSponsorCode(
      params.code!,
      { username: params.username, depositAmountCAW: params.depositAmountCAW },
      ip,
      budget,
    )
    if (!codeValidation.ok) {
      const statusMap: Record<string, number> = {
        INVALID_CODE_LOCKDOWN: 503,
        IP_BANNED: 403,
        CODE_RATE_LIMITED: 429,
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
    codeHash = codeValidation.codeHash
    kycLevel = codeValidation.requireKycLevel

    // Phase 2 Sponsor Repay derivation (code policy drives repay + KYC).
    if (codeValidation.repayBps > 0) {
      repayAmount = (params.depositAmountCAW * BigInt(codeValidation.repayBps)) / 10000n
      if (repayAmount > params.depositAmountCAW * 2n) {
        return res.status(400).json({
          error: 'VALIDATION',
          detail: `Computed repayAmount exceeds the 2x deposit cap (repayBps=${codeValidation.repayBps}).`,
        })
      }
      const envSponsorId = Number(process.env.PLATFORM_SPONSOR_TOKEN_ID ?? 1)
      sponsorTokenId = Number.isInteger(envSponsorId) && envSponsorId > 0 ? envSponsorId : 1
    }
  }

  // UX guard: confirm the FE-signed repayAmount matches the server-derived value
  // (mismatch → opaque on-chain MinterCallFailed). X path always has repay 0.
  const signedRepay = params.signedRepayAmount ?? 0n
  if (signedRepay !== repayAmount) {
    return res.status(400).json({
      error: 'REPAY_MISMATCH',
      detail: `Signed repayAmount (${signedRepay}) does not match the policy ` +
        `(${repayAmount}). Refresh and retry.`,
    })
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  const result = await service.sponsorBootstrap({
    ...params,
    kycLevel,
    sponsorTokenId,
    repayAmount,
    // Free-signup path: let the service accept the exact-zero deposit (the
    // min-deposit floor is a gifted-path anti-dust guard, not relevant here).
    allowZeroDeposit: isUngated,
  })
  if (isSponsorError(result)) {
    // Bootstrap failed — do NOT decrement usesRemaining (caller can retry).
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }

  // X-gate: burn the X account's free-mint eligibility by writing the
  // WalletXLink for the freshly-minted recipient. WalletXLink.xUserId @unique is
  // the global spent-set — this permanently prevents that X account from
  // claiming another sponsored mint (and from linking to any other wallet). The
  // unique constraint is also the authoritative backstop against a
  // check→mint race: a concurrent second mint with the same xUserId fails here
  // (caught + logged; the mint already succeeded, so we don't fail the response).
  if (xGate && result.recipient) {
    try {
      await prisma.walletXLink.create({
        data: {
          address:            result.recipient.toLowerCase(),
          xUserId:            xGate.xUserId,
          xHandle:            xGate.xHandle,
          xFollowerBucket:    null,
          linkedAt:           new Date(),
          followersUpdatedAt: new Date(),
        },
      })
    } catch (err) {
      // Unique-violation here means the X id (or wallet) was linked concurrently
      // — the spent-set held. The mint is already on-chain; log and continue.
      console.error('[sponsor/bootstrap] WalletXLink write (X-gate) failed:', err)
    }
  }

  // Account was actually CREATED — now (and only now) spend one IP quota slot.
  // Peek-only check above means failed/abandoned attempts never counted. Spend
  // against the SAME counter we peeked (ungated → its independent counter, so a
  // free signup never burns an invite-code slot and vice-versa). Fire-and-forget.
  void recordSponsorUse(ip, rateOp)   // fire-and-forget; handles its own errors

  // Commit the redemption audit row (code path only — X path has no codeHash).
  // Fire-and-forget so a DB hiccup doesn't break the user's UX.
  if (codeHash) {
    commitRedemption({
      codeHash,
      recipient: result.recipient ?? '',
      txHash: result.txHash,
      budget: budget ?? {
        gasCostUsdCents: 0,
        netFeesUsdCents: 0,
        lzFeeUsdCents: 0,
        depositUsdCents: 0,
        totalUsdCents: 0,
      },
    }).catch(err => console.error('[sponsor] commitRedemption failed:', err))
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
  void recordSponsorUse(ip, 'deposit')   // count only on success; fire-and-forget
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
  void recordSponsorUse(ip, 'authenticate')   // count only on success; fire-and-forget
  return res.status(200).json(result)
})

// ─── POST /api/sponsor/execute ──────────────────────────────────────────────
// Relay a passkey-signed SmartEOA.executeBatch (the validator fronts gas + the
// withdraw's LZ fee, recovered via the CAW fee transfer the user signed into the
// batch). Authorization is fully in `sig` — the server can only submit EXACTLY
// what the user signed, so it can't redirect funds or inflate the fee.
//
// THE POLICY GATE (protects the relayer's wallet). STRICT ALLOW-LIST, default-deny.
//
// History: this started as "allow-list targets + deny-list dangerous selectors".
// That enumerate-the-bad model leaked repeatedly — SEAM-EXEC-1 (Minter sponsor
// selectors drain relayer CAW via tx.origin), -2 (free LZ fee), -3 (approve/
// transferFrom) were all holes that existed BECAUSE a target was broadly allowed
// and we had to remember every bad selector on it. SEAM-EXEC-4 inverts it: the
// relay accepts ONLY the exact (target, selector) pairs a self-custody withdraw
// needs, and rejects everything else. A new drain vector can no longer appear
// silently — it can only appear if someone explicitly ADDS the pair that enables
// it. The endpoint is no longer a generic "exec"; it's a withdraw relay that
// happens to use batches.
//
// What a Pop-B withdraw batch is (the ONLY shape we relay):
//   1. CawProfile.withdrawTo(...)  — withdraw CAW to the user's OWN EOA
//   2. CAW.transfer(relayer, fee)  — repay the relayer (gas + forwarded ETH)
//   3. CAW.transfer(dest, rest)    — forward the net to the user's chosen address
// Two selectors total. The Minter is NOT an allowed target, so SEAM-EXEC-1's
// entire drain class is unreachable here (not merely denied).
//
// ADDING A CAPABILITY LATER (e.g. zap): add the exact (target, selector) pair
// below AND, if that selector can make the relayer pay, extend the fee/shape
// checks. depositZap lives on the MINTER (CAW_NAMES_MINTER_ADDRESS) and is
// self-funded by the user's ETH value — but adding it means re-reviewing that
// the relayer isn't left funding anything. Do NOT re-add the Minter as a broad
// target; add the one selector.
const SEL_WITHDRAW_TO   = '0xcdbafcd0' // CawProfile.withdrawTo(uint32,uint32,address,uint32,uint256)
const SEL_CAW_TRANSFER  = '0xa9059cbb' // CAW.transfer(address,uint256)

const CAW_NAMES_ADDRESS_LC = (process.env.CAW_NAMES_ADDRESS || '').toLowerCase()
const CAW_ADDRESS_LC = CAW_ADDRESS.toLowerCase()

// target (lowercased) → the exact selectors permitted on it. Anything not here
// is rejected. Empty when the env target isn't configured (route 503s).
const EXECUTE_ALLOWED: Record<string, Set<string>> = {}
if (CAW_NAMES_ADDRESS_LC) EXECUTE_ALLOWED[CAW_NAMES_ADDRESS_LC] = new Set([SEL_WITHDRAW_TO])
EXECUTE_ALLOWED[CAW_ADDRESS_LC] = new Set([SEL_CAW_TRANSFER])

// ERC-20 transfer(address,uint256) selector — used to decode the relayer-fee call.
const ERC20_TRANSFER_SELECTOR = SEL_CAW_TRANSFER
const ADDR_RE_EXEC = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x[0-9a-fA-F]*$/
const ExecuteBodySchema = z.object({
  smartEoaAddress: z.string().regex(ADDR_RE_EXEC),
  calls: z.array(z.object({
    to:    z.string().regex(ADDR_RE_EXEC),
    value: z.string().regex(/^\d+$/),     // wei, decimal string
    data:  z.string().regex(HEX_RE),
  })).min(1).max(8),
  nonce: z.string().regex(/^\d+$/),
  sig:   z.string().regex(HEX_RE),
})

/**
 * Decode a `transfer(address to, uint256 amount)` calldata. Returns null if the
 * calldata is not a well-formed ERC-20 transfer (wrong selector or length).
 * calldata = 0xa9059cbb || 32-byte to (right-aligned) || 32-byte amount.
 * 4 + 32 + 32 = 68 bytes = 138 hex chars incl. 0x.
 */
export function decodeErc20Transfer(data: string): { to: string; amount: bigint } | null {
  const lc = data.toLowerCase()
  if (!lc.startsWith(ERC20_TRANSFER_SELECTOR)) return null
  if (lc.length !== 2 + 8 + 64 + 64) return null
  const toWord = lc.slice(10, 74)              // 32 bytes
  // address occupies the low 20 bytes; the high 12 bytes must be zero.
  if (toWord.slice(0, 24) !== '0'.repeat(24)) return null
  const to = '0x' + toWord.slice(24)
  let amount: bigint
  try { amount = BigInt('0x' + lc.slice(74, 138)) } catch { return null }
  return { to, amount }
}

router.post('/execute', async (req, res) => {
  const service = getSponsorService()
  if (!service) {
    return res.status(503).json({ error: 'SPONSOR_DISABLED', detail: 'Sponsored relay is not enabled on this node' })
  }
  const ip = clientIp(req)
  // Reuse the deposit/auth limiter bucket (30/IP/day) — same risk class.
  const allowed = await checkSponsorRateLimit(ip, 'authenticate')
  if (!allowed) {
    return res.status(429).json({ error: 'RATE_LIMITED', detail: `Execute limit is ${DEPOSIT_AUTH_RATE_LIMIT} per IP per day` })
  }

  let body: z.infer<typeof ExecuteBodySchema>
  try {
    body = ExecuteBodySchema.parse(req.body)
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ') : String(e)
    return res.status(400).json({ error: 'VALIDATION', detail })
  }

  // STRICT ALLOW-LIST (SEAM-EXEC-4): every call must be an explicitly-permitted
  // (target, selector) pair. Default-deny — anything not in EXECUTE_ALLOWED is
  // rejected, so a new drain vector can't appear without an explicit code change.
  if (Object.keys(EXECUTE_ALLOWED).length === 0) {
    return res.status(503).json({ error: 'RELAY_UNCONFIGURED', detail: 'No allow-listed (target, selector) pairs configured' })
  }
  const smartEoaLc = body.smartEoaAddress.toLowerCase()
  for (const c of body.calls) {
    const toLc = c.to.toLowerCase()
    const allowedSelectors = EXECUTE_ALLOWED[toLc]
    if (!allowedSelectors) {
      return res.status(400).json({ error: 'TARGET_NOT_ALLOWED', detail: `Call target ${c.to} is not allow-listed` })
    }
    // Selector = first 4 bytes. Require full-length calldata so a malformed/short
    // call can't slip past the selector check (it would revert on-chain anyway).
    const selector = (c.data || '').length >= 10 ? c.data.slice(0, 10).toLowerCase() : ''
    if (!allowedSelectors.has(selector)) {
      return res.status(400).json({ error: 'SELECTOR_NOT_ALLOWED', detail: `Selector ${selector || '(none)'} on ${c.to} is not allow-listed` })
    }

    // SHAPE CHECK on withdrawTo: the `recipient` (3rd arg, an address) MUST be the
    // user's OWN SmartEOA. The relayer fronts the withdraw's ETH/LZ fee, so the
    // proceeds must land on the EOA (where the in-batch CAW.transfer fee is paid
    // from + verified). The user's chosen external destination is reached by the
    // SUBSEQUENT CAW.transfer, never by withdrawTo itself — so the relayer never
    // forwards value to an address it can't account for in the fee check.
    if (toLc === CAW_NAMES_ADDRESS_LC && selector === SEL_WITHDRAW_TO) {
      // withdrawTo(uint32,uint32,address,uint32,uint256): args start at byte 4.
      // recipient is the 3rd 32-byte word: data[10 + 64*2 ...]. Low 20 bytes.
      const recipientWord = c.data.slice(10 + 128, 10 + 192) // 3rd word, 64 hex chars
      if (recipientWord.length !== 64 || recipientWord.slice(0, 24) !== '0'.repeat(24)) {
        return res.status(400).json({ error: 'BAD_WITHDRAW_SHAPE', detail: 'withdrawTo recipient word is malformed' })
      }
      const recipient = '0x' + recipientWord.slice(24)
      if (recipient.toLowerCase() !== smartEoaLc) {
        return res.status(400).json({
          error: 'WITHDRAW_RECIPIENT_NOT_SELF',
          detail: `withdrawTo must withdraw to the signer's own EOA (${smartEoaLc}); ` +
            `got ${recipient}. Send to an external address via the CAW.transfer leg.`,
        })
      }
    }
  }

  // Total ETH value the relayer fronts as msg.value (e.g. the withdraw LZ fee).
  // Computed BEFORE the fee check so the CAW fee floor can cover it (SEAM-EXEC-2).
  // Cap mirrors SponsorService.relayExecuteBatch's maxLzFeeWei check (re-checked there).
  let totalValue = 0n
  try { totalValue = body.calls.reduce((acc, c) => acc + BigInt(c.value), 0n) } catch {
    return res.status(400).json({ error: 'VALIDATION', detail: 'Invalid call value' })
  }

  // ── FEE INVARIANT: the batch must repay the relayer in CAW for what it fronts —
  //    GAS to submit the tx PLUS the ETH `value` forwarded into the batch (the LZ
  //    fee on a withdraw). Otherwise relaying is an open subsidy and the whole
  //    "anyone submits, submitter keeps the fee" model collapses. Sum every
  //    CAW.transfer in the batch whose recipient is THIS relayer's hot wallet, and
  //    require the total to meet the live quote (gas + forwardedValue). The fee +
  //    recipient are signature-bound, so a relayer can't inflate the fee and the
  //    user can't fake it post-hoc.
  //    SEAM-EXEC-2 (audit 2026-06-14): totalValue MUST be priced in — pricing only
  //    gas let a withdraw get its LZ fee fronted for free.
  const feeQuote = quoteExecuteGasFeeCaw(totalValue)
  if (!feeQuote.priceAvailable) {
    // No live price → we can't price the cost → refuse rather than relay for free
    // or against a stale-low rate (mirrors inviteQuote's M-2 staleness refusal).
    return res.status(503).json({
      error: 'PRICE_UNAVAILABLE',
      detail: 'CAW/ETH price is unavailable or stale; cannot price the relay fee. Try again shortly.',
    })
  }
  const relayer = service.relayerAddress().toLowerCase()
  let feePaidCawWei = 0n
  for (const c of body.calls) {
    if (c.to.toLowerCase() !== CAW_ADDRESS_LC) continue
    const decoded = decodeErc20Transfer(c.data)
    if (decoded && decoded.to.toLowerCase() === relayer) {
      feePaidCawWei += decoded.amount
    }
  }
  if (feePaidCawWei < feeQuote.minFeeCawWei) {
    return res.status(400).json({
      error: 'FEE_TOO_LOW',
      detail:
        `Batch must transfer at least ${feeQuote.minFeeCawWei} CAW (wei) to the relayer ` +
        `${relayer} to cover gas + forwarded ETH; batch pays ${feePaidCawWei}. Re-quote and re-sign.`,
    })
  }

  const result = await service.relayExecuteBatch(
    body.smartEoaAddress,
    body.calls.map(c => ({ to: c.to, value: BigInt(c.value), data: c.data })),
    BigInt(body.nonce),
    body.sig,
    totalValue,
  )
  if (isSponsorError(result)) {
    const status = result.error === 'TREASURY_LOW' ? 503 : 400
    return res.status(status).json(result)
  }
  void recordSponsorUse(ip, 'authenticate')   // count only on success (shared bucket); fire-and-forget
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

// ─── GET /api/sponsor/invite-quote ───────────────────────────────────────────
// Public pricing for the PAID buy-a-code flow. The FE uses this to clamp the
// amount input (>= gasFloor) and render USD. The on-chain handler uses the same
// helper to gate the tip. Amounts are WHOLE CAW (string) matching the on-chain
// amounts[] convention.
//
// { gasFloorCaw, gasMarginCaw, cawUsdRate, priceAvailable, validatorTokenId? }
//
// validatorTokenId is THIS server's validator profile id — the FE must set it as
// recipients[0] so this mirror is the one that mints. Resolved lazily; omitted
// (null) until the validator identity is known.
router.get('/invite-quote', async (_req, res) => {
  const quote = quoteSponsorInviteCostCaw()
  const validatorTokenId = await getOwnValidatorTokenId().catch(() => null)
  return res.status(200).json({
    gasFloorCaw: quote.gasFloorCaw.toString(),
    gasMarginCaw: quote.gasMarginCaw.toString(),
    maxGiftCaw: quote.maxGiftCaw.toString(),
    cawUsdRate: quote.cawUsdRate,
    priceAvailable: quote.priceAvailable,
    validatorTokenId,
  })
})

// ─── GET /api/sponsor/execute-quote ──────────────────────────────────────────
// Public. The CAW fee (wei) a passkey-wallet executeBatch must transfer to the
// relayer to cover the gas it fronts, plus the relayer address to pay it to. The
// FE reads this to build the fee call inside a withdraw/zap batch BEFORE signing.
// The /execute relay re-derives the same quote authoritatively and rejects a
// batch that underpays — this endpoint is a UX pre-flight, not a trust boundary.
router.get('/execute-quote', async (_req, res) => {
  const service = getSponsorService()
  const quote = quoteExecuteGasFeeCaw()
  return res.status(200).json({
    relayer: service ? service.relayerAddress() : null,
    minFeeCawWei: quote.minFeeCawWei.toString(),
    priceAvailable: quote.priceAvailable,
    cawAddress: CAW_ADDRESS,
  })
})

// ─── GET /api/sponsor/my-codes ───────────────────────────────────────────────
// Wallet-session authed. Returns the invite codes the caller PURCHASED (across
// all their authorized profiles), with the decrypted plaintext + used/unused
// status. Used-status is derived from the linked SponsorCode.usesRemaining.
//
// Only this server (the minting mirror) holds the buyer's PurchasedInviteCode +
// the decryption key, so codes appear on the mirror that processed the purchase.
router.get('/my-codes', requireAuth({ anySession: true }), async (req, res) => {
  const tokenIds = req.sessionData?.authorizedTokenIds ?? []
  if (tokenIds.length === 0) return res.status(200).json({ codes: [] })

  const purchased = await prisma.purchasedInviteCode.findMany({
    where: { purchasedByTokenId: { in: tokenIds } },
    orderBy: { createdAt: 'desc' },
  })
  if (purchased.length === 0) return res.status(200).json({ codes: [] })

  // Pull the linked SponsorCode rows in one query for used/unused + expiry.
  const hashes = purchased.map(p => p.codeHash)
  const codes = await prisma.sponsorCode.findMany({ where: { codeHash: { in: hashes } } })
  const byHash = new Map(codes.map(c => [c.codeHash, c]))

  const out = purchased.map(p => {
    const sc = byHash.get(p.codeHash)
    // Decrypt best-effort; if the key rotated or the envelope is corrupt, omit
    // the plaintext rather than 500 the whole list.
    let code: string | null = null
    try { code = decryptInviteCode(p.codeCiphertext) } catch { code = null }
    const used = sc ? (sc.usesRemaining !== null && sc.usesRemaining <= 0) : false
    return {
      code,
      used,
      usesRemaining: sc?.usesRemaining ?? null,
      giftCawWei: p.giftCawWei,
      paidCawWei: p.paidCawWei,
      createdAt: p.createdAt.toISOString(),
      expiresAt: sc?.expiresAt ? sc.expiresAt.toISOString() : null,
    }
  })

  return res.status(200).json({ codes: out })
})

export default router
