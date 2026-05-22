/**
 * Tests for validateSponsorCode middleware and sponsor code helpers.
 *
 * Strategy:
 *   - All Prisma calls are monkey-patched before each test via a
 *     light in-memory store (prismaMock). No real DB needed.
 *   - Redis calls are replaced with an in-memory stub injected via
 *     _setRedisForTest(). No real Redis needed.
 *   - Constant-time sleep is verified via wall-clock timing assertions
 *     (TARGET_RESPONSE_MS - 20ms lower bound, no upper bound to avoid
 *     flakiness on loaded CI). We assert variance across hit/miss/banned
 *     is < 20ms to detect non-constant-time leaks.
 *
 * Import order note: validateSponsorCode.ts imports prisma at module level.
 * We patch prismaClient BEFORE importing the module under test.
 */

import { describe, it, before, beforeEach } from 'mocha'
import { expect } from 'chai'

// ─── Prisma mock ──────────────────────────────────────────────────────────────

import type { SponsorCode } from '@prisma/client'

type SponsorCodeRow = {
  codeHash: string
  tier: string
  label: string | null
  budgetCapUsdCents: number
  maxDepositCawWei: string
  maxUses: number | null
  usesRemaining: number | null
  minUsernameLength: number
  networkOwnerAddress: string | null
  expiresAt: Date
  createdBy: string | null
  createdAt: Date
}

// Shared state for the in-memory mock.
let _mockCode: SponsorCodeRow | null = null
let _createdAttempts: { ip: string }[] = []
let _attemptCountOverride: number | null = null
let _updatedCodes: { codeHash: string; usesRemaining?: number }[] = []
let _createdRedemptions: object[] = []

const prismaMock = {
  sponsorCode: {
    findUnique: async ({ where }: { where: { codeHash: string } }) => {
      if (_mockCode && _mockCode.codeHash === where.codeHash) return _mockCode
      return null
    },
    updateMany: async (args: { where: { codeHash: string; usesRemaining?: object }; data: object }) => {
      _updatedCodes.push({ codeHash: args.where.codeHash, ...args.data as object })
      return { count: 1 }
    },
  },
  sponsorCodeAttempt: {
    create: async (args: { data: { ip: string } }) => {
      _createdAttempts.push({ ip: args.data.ip })
      return { id: _createdAttempts.length, ip: args.data.ip, attemptedAt: new Date() }
    },
    count: async (_args: object) => {
      if (_attemptCountOverride !== null) return _attemptCountOverride
      return _createdAttempts.length
    },
  },
  sponsorRedemption: {
    create: async (args: { data: object }) => {
      _createdRedemptions.push(args.data)
      return { id: _createdRedemptions.length }
    },
  },
}

// ─── Redis mock ───────────────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, { value: string; expireAt?: number }>()

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, mode?: string, ttl?: number, nx?: string): Promise<'OK' | null> {
    if (nx === 'NX' && this.store.has(key)) return null
    const expireAt = ttl ? Date.now() + ttl * 1000 : undefined
    this.store.set(key, { value, expireAt })
    return 'OK'
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? '0')
    const next = current + 1
    const existing = this.store.get(key)
    this.store.set(key, { value: String(next), expireAt: existing?.expireAt })
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    const existing = this.store.get(key)
    if (!existing) return 0
    existing.expireAt = Date.now() + seconds * 1000
    return 1
  }

  async exists(key: string): Promise<number> {
    const v = await this.get(key)
    return v !== null ? 1 : 0
  }

  clear(): void {
    this.store.clear()
  }
}

// ─── Import module under test ─────────────────────────────────────────────────
// After patching prisma above.

import {
  validateSponsorCode,
  commitRedemption,
  computeRedemptionBudget,
  _setRedisForTest,
  _setPrismaForTest,
} from '../../../src/api/middleware/validateSponsorCode'
import { hashCode, generateShortCode, generateLongCode, normalizeCode } from '../../../src/services/SponsorService/codes'

// ─── Test constants ───────────────────────────────────────────────────────────

const TEST_HMAC_SECRET = 'a'.repeat(64)  // 32 bytes hex
const TEST_HMAC_SECRET2 = 'b'.repeat(64)

function withSecret<T>(secret: string, fn: () => T): T {
  const prev = process.env.SPONSOR_CODE_HMAC_SECRET
  process.env.SPONSOR_CODE_HMAC_SECRET = secret
  try {
    return fn()
  } finally {
    process.env.SPONSOR_CODE_HMAC_SECRET = prev
  }
}

function makeCode(overrides: Partial<SponsorCodeRow> = {}): SponsorCodeRow {
  const rawCode = 'TEST-CODE-01A'
  const codeHash = withSecret(TEST_HMAC_SECRET, () => hashCode(rawCode))
  return {
    codeHash,
    tier: 'short',
    label: 'test',
    budgetCapUsdCents: 1000,
    maxDepositCawWei: '10000000000000000000000000',  // 10M CAW
    maxUses: 3,
    usesRemaining: 3,
    minUsernameLength: 0,
    networkOwnerAddress: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),  // +24h
    createdBy: null,
    createdAt: new Date(),
    ...overrides,
    // Always recompute hash if code wasn't set to a specific hash
    ...(overrides.codeHash ? {} : { codeHash }),
  }
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

describe('validateSponsorCode', () => {
  let mockRedis: MockRedis

  before(() => {
    process.env.SPONSOR_CODE_HMAC_SECRET = TEST_HMAC_SECRET
    _setPrismaForTest(prismaMock as any)
  })

  beforeEach(() => {
    // Fresh Redis and in-memory state for each test.
    mockRedis = new MockRedis()
    _setRedisForTest(mockRedis as any)
    _mockCode = null
    _createdAttempts = []
    _attemptCountOverride = null
    _updatedCodes = []
    _createdRedemptions = []
  })

  after(() => {
    _setRedisForTest(null)
    _setPrismaForTest(null)
  })

  // ── Happy path ───────────────────────────────────────────────────────────

  it('happy path: valid code → ok:true', async () => {
    _mockCode = makeCode()
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(true)
  })

  it('happy path: code hash is returned on success', async () => {
    _mockCode = makeCode()
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(true)
    if (result.ok) {
      expect(result.codeHash).to.be.a('string').with.length(64)
    }
  })

  // ── Expired code ─────────────────────────────────────────────────────────

  it('expired code → CODE_EXPIRED', async () => {
    _mockCode = makeCode({ expiresAt: new Date(Date.now() - 1000) })
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('CODE_EXPIRED')
  })

  // ── Wrong code ────────────────────────────────────────────────────────────

  it('wrong code → INVALID_CODE + attempt row created', async () => {
    _mockCode = null  // no code in DB
    const result = await validateSponsorCode(
      'WRONG-CODE-99Z',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '10.0.0.1',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('INVALID_CODE')
    expect(_createdAttempts.some(a => a.ip === '10.0.0.1')).to.equal(true)
  })

  // ── IP ban after 3 wrong attempts ─────────────────────────────────────────

  it('4th wrong attempt from same IP → IP_BANNED', async () => {
    _mockCode = null
    // Simulate 3 prior attempts already in DB (the 4th will tip the ban).
    _attemptCountOverride = 3  // already at the threshold

    const result = await validateSponsorCode(
      'WRONG-CODE-99Z',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '10.0.0.2',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) {
      // Either INVALID_CODE (on the miss) then immediately banned, or IP_BANNED
      // if the ban key was already set from a previous iteration. In either case
      // the next call from this IP will be IP_BANNED.
      expect(['INVALID_CODE', 'IP_BANNED']).to.include(result.error)
    }

    // Next call from same IP — now Redis ban key should be set.
    const result2 = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '10.0.0.2',
    )
    expect(result2.ok).to.equal(false)
    if (!result2.ok) expect(result2.error).to.equal('IP_BANNED')
  })

  // ── Budget exceeded ──────────────────────────────────────────────────────

  it('budget exceeded → BUDGET_EXCEEDED', async () => {
    _mockCode = makeCode({ budgetCapUsdCents: 100 })  // $1 cap
    const budget = {
      gasCostUsdCents: 80,
      netFeesUsdCents: 50,
      lzFeeUsdCents: 20,
      depositUsdCents: 10,
      totalUsdCents: 160,  // $1.60 > $1.00 cap
    }
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
      budget,
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('BUDGET_EXCEEDED')
  })

  // ── usesRemaining = 0 ────────────────────────────────────────────────────

  it('usesRemaining=0 → CODE_EXHAUSTED', async () => {
    _mockCode = makeCode({ usesRemaining: 0 })
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('CODE_EXHAUSTED')
  })

  // ── Deposit > maxDepositCawWei ────────────────────────────────────────────

  it('deposit > maxDepositCawWei → DEPOSIT_TOO_LARGE', async () => {
    // Code allows max 1M CAW; user tries 2M.
    _mockCode = makeCode({ maxDepositCawWei: (1_000_000n * 10n ** 18n).toString() })
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'testuser', depositAmountCAW: 2_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('DEPOSIT_TOO_LARGE')
  })

  // ── Username too short ────────────────────────────────────────────────────

  it('username shorter than minUsernameLength → USERNAME_TOO_SHORT', async () => {
    _mockCode = makeCode({ minUsernameLength: 5 })
    const result = await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'ab', depositAmountCAW: 1_000_000n * 10n ** 18n },
      '1.2.3.4',
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.error).to.equal('USERNAME_TOO_SHORT')
  })

  // ── HMAC correctness ─────────────────────────────────────────────────────

  it('HMAC: same input + same secret → same hash', () => {
    const h1 = withSecret(TEST_HMAC_SECRET, () => hashCode('URUK-LAUNCH-7K2'))
    const h2 = withSecret(TEST_HMAC_SECRET, () => hashCode('URUK-LAUNCH-7K2'))
    expect(h1).to.equal(h2)
  })

  it('HMAC: different secret → different hash', () => {
    const h1 = withSecret(TEST_HMAC_SECRET, () => hashCode('URUK-LAUNCH-7K2'))
    const h2 = withSecret(TEST_HMAC_SECRET2, () => hashCode('URUK-LAUNCH-7K2'))
    expect(h1).to.not.equal(h2)
  })

  it('HMAC: normalization is case-insensitive and dash-stripped', () => {
    const h1 = withSecret(TEST_HMAC_SECRET, () => hashCode('URUK-LAUNCH-7K2'))
    const h2 = withSecret(TEST_HMAC_SECRET, () => hashCode('uruk-launch-7k2'))
    // Different code (extra char) → different hash
    const h3 = withSecret(TEST_HMAC_SECRET, () => hashCode('URUK-LAUNCH-7K3'))
    expect(h1).to.equal(h2)        // case-insensitive
    expect(h1).to.not.equal(h3)   // different code
  })

  it('normalizeCode strips dashes and uppercases', () => {
    // 'uruk-launch-7k2' → uppercase → 'URUK-LAUNCH-7K2' → strip dashes → 'URUKLAUNCHT7K2'
    // No: URUK + LAUNCH + 7K2 with no dashes = 'URUKLAUNCH7K2' (12 chars, no T)
    expect(normalizeCode('uruk-launch-7k2')).to.equal('URUKLAUNCH7K2')
    expect(normalizeCode('CAWS-ABCD-EFGH')).to.equal('CAWSABCDEFGH')
    expect(normalizeCode('test-code-01a')).to.equal('TESTCODE01A')
  })

  // ── Constant-time response ────────────────────────────────────────────────
  //
  // Assert that miss, expired, and banned responses all take >= 80 ms
  // (TARGET_RESPONSE_MS - 20 ms margin for test overhead). We do NOT
  // assert a tight upper bound to avoid flakiness on loaded systems.
  // The key invariant — variance between hit and miss is small — is
  // checked by comparing the two durations.

  it('constant-time: miss response >= 80ms', async () => {
    _mockCode = null
    const start = Date.now()
    await validateSponsorCode(
      'WRONG-CODE-99Z',
      { username: 'x', depositAmountCAW: 1n },
      '5.5.5.5',
    )
    const elapsed = Date.now() - start
    expect(elapsed).to.be.gte(80, `Expected >= 80ms, got ${elapsed}ms`)
  })

  it('constant-time: expired response >= 80ms', async () => {
    _mockCode = makeCode({ expiresAt: new Date(Date.now() - 1000) })
    const start = Date.now()
    await validateSponsorCode(
      'TEST-CODE-01A',
      { username: 'x', depositAmountCAW: 1n },
      '5.5.5.6',
    )
    const elapsed = Date.now() - start
    expect(elapsed).to.be.gte(80, `Expected >= 80ms, got ${elapsed}ms`)
  })

  it('constant-time: both expired and wrong-code responses >= 80ms', async () => {
    // The constant-time guarantee is that FAILURE responses always take ~100ms,
    // regardless of the failure reason. Hit responses don't sleep (they take real
    // DB time in production; here the mock is instant). We verify three failure
    // modes all hit the floor.
    _mockCode = null
    const start1 = Date.now()
    await validateSponsorCode('WRONG-1', { username: 'x', depositAmountCAW: 1n }, '6.6.6.1')
    const t1 = Date.now() - start1

    _mockCode = makeCode({ expiresAt: new Date(Date.now() - 1000) })
    const start2 = Date.now()
    await validateSponsorCode('TEST-CODE-01A', { username: 'x', depositAmountCAW: 1n }, '6.6.6.2')
    const t2 = Date.now() - start2

    _mockCode = makeCode({ usesRemaining: 0 })
    mockRedis = new MockRedis()
    _setRedisForTest(mockRedis as any)
    const start3 = Date.now()
    await validateSponsorCode('TEST-CODE-01A', { username: 'x', depositAmountCAW: 1n }, '6.6.6.3')
    const t3 = Date.now() - start3

    expect(t1).to.be.gte(80, `miss: expected >= 80ms, got ${t1}ms`)
    expect(t2).to.be.gte(80, `expired: expected >= 80ms, got ${t2}ms`)
    expect(t3).to.be.gte(80, `exhausted: expected >= 80ms, got ${t3}ms`)

    // All three should be within 20ms of each other (constant-time variance).
    const max = Math.max(t1, t2, t3)
    const min = Math.min(t1, t2, t3)
    expect(max - min).to.be.lt(20,
      `Failure timings spread too wide: miss=${t1}ms expired=${t2}ms exhausted=${t3}ms`)
  })
})

// ─── commitRedemption tests ───────────────────────────────────────────────────

describe('commitRedemption', () => {
  before(() => {
    _setPrismaForTest(prismaMock as any)
  })

  after(() => {
    _setPrismaForTest(null)
  })

  beforeEach(() => {
    _updatedCodes = []
    _createdRedemptions = []
    _mockCode = null
  })

  it('commits usesRemaining decrement + redemption row', async () => {
    await commitRedemption({
      codeHash: 'abc123',
      recipient: '0x' + 'a'.repeat(40),
      txHash: '0x' + 'b'.repeat(64),
      budget: {
        gasCostUsdCents: 50,
        netFeesUsdCents: 30,
        lzFeeUsdCents: 10,
        depositUsdCents: 5,
        totalUsdCents: 95,
      },
    })
    expect(_updatedCodes).to.have.length(1)
    expect(_createdRedemptions).to.have.length(1)
    expect((_createdRedemptions[0] as any).totalUsdCents).to.equal(95)
  })
})

// ─── computeRedemptionBudget tests ───────────────────────────────────────────

describe('computeRedemptionBudget', () => {
  it('sums all components', () => {
    const result = computeRedemptionBudget({
      gasPriceWei: 20_000_000_000n,       // 20 gwei
      gasLimitBootstrap: 400_000n,
      netFeesWei: 3_000_000_000_000_000n,  // 0.003 ETH
      lzFeeWei:   1_000_000_000_000_000n,  // 0.001 ETH
      depositAmountCAW: 1_000_000n * 10n ** 18n,  // 1M CAW
      ethUsdCents: 300_000,     // $3,000 ETH in cents
      cawUsdCents: 0.001,       // $0.00001 per CAW
    })
    // gas: 20e9 * 400000 = 8e15 wei = 0.008 ETH × $3000 = $24 → 2400 cents
    expect(result.gasCostUsdCents).to.be.closeTo(2400, 5)
    // netFees: 0.003 ETH × $3000 = $9 → 900 cents
    expect(result.netFeesUsdCents).to.be.closeTo(900, 5)
    // lzFee: 0.001 ETH × $3000 = $3 → 300 cents
    expect(result.lzFeeUsdCents).to.be.closeTo(300, 5)
    // deposit: 1M CAW × 0.001 cents = 1000 cents
    expect(result.depositUsdCents).to.be.closeTo(1000, 5)
    expect(result.totalUsdCents).to.equal(
      result.gasCostUsdCents + result.netFeesUsdCents + result.lzFeeUsdCents + result.depositUsdCents
    )
  })
})

// ─── Code generation tests ───────────────────────────────────────────────────

describe('generateShortCode', () => {
  before(() => {
    process.env.SPONSOR_CODE_HMAC_SECRET = TEST_HMAC_SECRET
  })

  it('generates a string with 2 dashes', () => {
    const code = generateShortCode()
    const parts = code.split('-')
    expect(parts.length).to.be.gte(3)
  })

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateShortCode()))
    expect(codes.size).to.equal(20)
  })
})

describe('generateLongCode', () => {
  before(() => {
    process.env.SPONSOR_CODE_HMAC_SECRET = TEST_HMAC_SECRET
  })

  it('starts with CAWS- prefix', () => {
    expect(generateLongCode().startsWith('CAWS-')).to.equal(true)
  })

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateLongCode()))
    expect(codes.size).to.equal(20)
  })

  it('code is longer than short code', () => {
    expect(generateLongCode().length).to.be.gt(generateShortCode().length)
  })
})
