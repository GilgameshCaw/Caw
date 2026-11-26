import { expect } from 'chai'
import express from 'express'
import path from 'path'
import request from 'supertest'
import { Wallet } from 'ethers'
import {
  DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH,
  MAX_OPEN_SIGNUP_MIN_USERNAME_LENGTH,
  openSignupMinUsernameLength,
  openSignupNameRefusal,
} from '../../../src/api/shared/openSignupName'

// A sponsored signup with no invite code (X token, ungated) has no pot to size
// the name against, and the sponsor wallet pays the whole username burn. These
// tests cover the floor on the name length for those two gates, and that nothing
// else is refused by it. No database, no Redis, no chain: the one call that would
// reach the chain is replaced, and Redis is a stand-in for the length of the test.

const ERROR = 'OPEN_SIGNUP_USERNAME_TOO_SHORT'

describe('openSignupMinUsernameLength', () => {
  const saved = process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
  afterEach(() => {
    if (saved === undefined) delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
    else process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = saved
  })

  it('is 8 by default, the shortest name that costs the base burn', () => {
    delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
    expect(DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH).to.equal(8)
    expect(openSignupMinUsernameLength()).to.equal(8)
  })

  it('takes a whole number from 1 to 32, the longest name the API accepts, from the environment', () => {
    expect(MAX_OPEN_SIGNUP_MIN_USERNAME_LENGTH).to.equal(32)
    for (const [raw, want] of [['6', 6], ['1', 1], ['32', 32], [' 7 ', 7], ['12', 12]] as const) {
      process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = raw
      expect(openSignupMinUsernameLength(), raw).to.equal(want)
    }
  })

  it('falls back to 8 for anything else, including a floor no name could meet', () => {
    for (const raw of ['', '  ', '0', '-3', '33', '40', '255', '256', '1.5', 'abc', 'NaN', '1e1', '+8']) {
      process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = raw
      expect(openSignupMinUsernameLength(), JSON.stringify(raw)).to.equal(8)
    }
  })
})

describe('openSignupNameRefusal', () => {
  const saved = process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
  beforeEach(() => { delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH })
  afterEach(() => {
    if (saved === undefined) delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
    else process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = saved
  })

  it('refuses a name under 8 characters when there is no invite code', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const refusal = openSignupNameRefusal(false, 'a'.repeat(n))
      expect(refusal, `${n} characters`).to.not.equal(null)
      expect(refusal!.error).to.equal(ERROR)
      expect(refusal!.detail).to.contain('at least 8 characters')
    }
  })

  it('lets a name of 8 characters or more through when there is no invite code', () => {
    for (const n of [8, 9, 16, 32]) {
      expect(openSignupNameRefusal(false, 'a'.repeat(n)), `${n} characters`).to.equal(null)
    }
  })

  it('never refuses a request that has an invite code, however short the name: the code\'s pot sizes it', () => {
    for (const n of [1, 2, 4, 6, 7, 8]) {
      expect(openSignupNameRefusal(true, 'a'.repeat(n)), `${n} characters`).to.equal(null)
    }
  })

  it('follows the floor from the environment', () => {
    process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = '6'
    expect(openSignupNameRefusal(false, 'abcde')!.detail).to.contain('at least 6 characters')
    expect(openSignupNameRefusal(false, 'abcdef')).to.equal(null)
    process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = '12'
    expect(openSignupNameRefusal(false, 'abcdefghijk')).to.not.equal(null)
    expect(openSignupNameRefusal(false, 'abcdefghijkl')).to.equal(null)
  })
})

// ─── Through the real router ────────────────────────────────────────────────

const ENV_KEYS = [
  'SPONSOR_ENABLED', 'SPONSOR_CODE_HMAC_SECRET', 'SPONSOR_L1_RPC_URL', 'SPONSOR_HOT_WALLET_PRIVATE_KEY',
  'SPONSOR_UNGATED_ENABLED', 'SPONSOR_OPEN_MIN_USERNAME_LENGTH', 'SMART_EOA_ADDRESS',
  'CAW_NAMES_MINTER_ADDRESS', 'CAW_NAMES_ADDRESS',
]

function baseBody(extra: Record<string, unknown>) {
  return {
    passkeyPubkeyX: '0x' + 'aa'.repeat(32),
    passkeyPubkeyY: '0x' + 'bb'.repeat(32),
    ecdsaFallbackAddr: '0x' + 'cc'.repeat(20),
    depositAmountCAW: '0',
    networkId: 1,
    lzDestId: 40245,
    lzTokenAmount: '1000',
    authTupleSignature: { yParity: 0, r: '0x' + 'aa'.repeat(32), s: '0x' + 'bb'.repeat(32) },
    authTupleNonce: '0',
    permitSig: '0x' + 'ff'.repeat(65),
    permitNonce: '0',
    ...extra,
  }
}

// A Redis stand-in: every command answers null at once. The route and the modules
// it reads at import time create their clients with `new Redis(...)`, and a real
// client with nothing behind it queues the command and waits.
class FakeRedis {
  constructor() {
    const self: any = new Proxy(this, {
      get: (_t, prop) => (prop === 'then' ? undefined : prop === 'on' || prop === 'once' ? () => self : async () => null),
    })
    return self
  }
  static Redis: any
  static Cluster: any
}
FakeRedis.Redis = FakeRedis
FakeRedis.Cluster = FakeRedis

describe('POST /api/sponsor/bootstrap: name length on the gates without an invite code', function () {
  this.timeout(15000)

  const SRC = path.resolve(__dirname, '../../../src')
  const routePath = require.resolve(path.join(SRC, 'api/routes/sponsor'))
  const servicePath = require.resolve(path.join(SRC, 'services/SponsorService'))
  // Modules that make a Redis client when they are loaded. They are loaded again
  // here, with the stand-in, and the copies the other tests already hold are put
  // back afterwards.
  const evict = [
    routePath,
    servicePath,
    require.resolve(path.join(SRC, 'api/routes/xSignup')),
    require.resolve(path.join(SRC, 'api/routes/xOauthCore')),
    require.resolve(path.join(SRC, 'api/middleware/validateSponsorCode')),
  ]

  const savedEnv: Record<string, string | undefined> = {}
  let before_: Set<string>
  const savedModules = new Map<string, NodeJS.Module | undefined>()
  let app: express.Express
  let reachedService: Array<{ username: string }>

  before(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    process.env.SPONSOR_ENABLED = '1'
    process.env.SPONSOR_CODE_HMAC_SECRET = 'a'.repeat(64)
    process.env.SPONSOR_L1_RPC_URL = 'http://127.0.0.1:1'
    process.env.SPONSOR_HOT_WALLET_PRIVATE_KEY = Wallet.createRandom().privateKey
    process.env.SPONSOR_UNGATED_ENABLED = 'true'
    delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
    process.env.SMART_EOA_ADDRESS = '0x00000000000000000000000000000000000000e1'
    process.env.CAW_NAMES_MINTER_ADDRESS = '0x00000000000000000000000000000000000000e2'
    process.env.CAW_NAMES_ADDRESS = '0x00000000000000000000000000000000000000e3'

    before_ = new Set(Object.keys(require.cache))
    for (const p of evict) { savedModules.set(p, require.cache[p]); delete require.cache[p] }
    const ioPath = require.resolve('ioredis')
    savedModules.set(ioPath, require.cache[ioPath])
    require.cache[ioPath] = { id: ioPath, filename: ioPath, loaded: true, exports: FakeRedis, children: [], paths: [] } as unknown as NodeJS.Module

    // A fresh route and a fresh SponsorService (and its one cached instance), so
    // the ungated switch read at import is the one set above.
    const SponsorServiceClass = require(servicePath).SponsorService
    reachedService = []
    SponsorServiceClass.prototype.sponsorBootstrap = async function (p: any) {
      reachedService.push({ username: p.username })
      return { error: 'STUBBED', detail: 'no chain in this test' }
    }
    app = express()
    app.use(express.json())
    app.use('/api/sponsor', require(routePath).default)
  })

  after(() => {
    // Whatever was loaded for this test goes, and the earlier copies come back.
    for (const k of Object.keys(require.cache)) if (!before_.has(k)) delete require.cache[k]
    for (const [p, mod] of savedModules) {
      if (mod === undefined) delete require.cache[p]
      else require.cache[p] = mod
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  beforeEach(() => { reachedService = [] })

  for (const name of ['a', 'ab', 'abcd', 'abcdef', 'abcdefg']) {
    it(`ungated: refuses "${name}" (${name.length} characters) with 400 ${ERROR}`, async () => {
      const res = await request(app).post('/api/sponsor/bootstrap').send(baseBody({ username: name }))
      expect(res.status).to.equal(400)
      expect(res.body.error).to.equal(ERROR)
      expect(reachedService).to.have.lengthOf(0)
    })

    it(`X token: refuses "${name}" (${name.length} characters) before the token is used`, async () => {
      // The token is never looked up: the length check comes first. A made-up
      // token proves it, since looking it up would have answered X_TOKEN_INVALID.
      const res = await request(app)
        .post('/api/sponsor/bootstrap')
        .send(baseBody({ username: name, depositAmountCAW: '1000000000000000000000000', xQualifiedToken: 'not-a-real-token-0123456789' }))
      expect(res.status).to.equal(400)
      expect(res.body.error).to.equal(ERROR)
      expect(reachedService).to.have.lengthOf(0)
    })
  }

  it('ungated: a name of 8 characters is not refused and reaches the service', async () => {
    const res = await request(app).post('/api/sponsor/bootstrap').send(baseBody({ username: 'abcdefgh' }))
    expect(res.body.error).to.equal('STUBBED')
    expect(reachedService).to.deep.equal([{ username: 'abcdefgh' }])
  })

  it('X token: a name of 8 characters is not refused for its length; the token is looked up next', async () => {
    const res = await request(app)
      .post('/api/sponsor/bootstrap')
      .send(baseBody({ username: 'abcdefgh', depositAmountCAW: '1000000000000000000000000', xQualifiedToken: 'not-a-real-token-0123456789' }))
    expect(res.status).to.equal(400)
    expect(res.body.error).to.equal('X_TOKEN_INVALID')
    expect(reachedService).to.have.lengthOf(0)
  })

  it('an invite code is not refused by this check, however short the name', async () => {
    // The code is made up, so the code gate itself turns the request down (or fails
    // for lack of a database); what matters is that this check is not what answers.
    const res = await request(app)
      .post('/api/sponsor/bootstrap')
      .send(baseBody({ username: 'abcd', depositAmountCAW: '1000000000000000000000000', code: 'MADEUPCODE12345' }))
    expect(res.body.error).to.not.equal(ERROR)
    expect(reachedService).to.have.lengthOf(0)
  })

  it('the floor follows SPONSOR_OPEN_MIN_USERNAME_LENGTH', async () => {
    process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH = '10'
    try {
      const res = await request(app).post('/api/sponsor/bootstrap').send(baseBody({ username: 'abcdefghi' }))
      expect(res.status).to.equal(400)
      expect(res.body.error).to.equal(ERROR)
      expect(res.body.detail).to.contain('at least 10 characters')
      const ok = await request(app).post('/api/sponsor/bootstrap').send(baseBody({ username: 'abcdefghij' }))
      expect(ok.body.error).to.equal('STUBBED')
    } finally {
      delete process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
    }
  })
})
