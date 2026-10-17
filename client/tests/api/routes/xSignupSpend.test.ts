/**
 * The X-signup gate's spend guarantees, at the helper level:
 *   1. An X-qualified token is single-use even under concurrent consumes.
 *   2. One xUserId can back at most one sponsored mint, however many tokens
 *      were issued for it (each OAuth round-trip issues a fresh token, and the
 *      callback's already-linked check only sees mints that have finished).
 *   3. A reservation carries what an operator needs to clear it by hand, and
 *      one whose mint tx was sent with an unknown outcome is kept.
 *
 * Redis and Prisma are in-memory stubs injected through the module's test
 * seams. The stub's multi().exec() runs its queue synchronously, which is the
 * property a real MULTI/EXEC gives; plain get-then-del does not have it.
 */

// Point the module's default Redis client at a port nothing listens on, so
// importing the module cannot reach a real Redis.
process.env.REDIS_URL = 'redis://127.0.0.1:1/15'

import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'

type Entry = { value: string; expireAt?: number }

class MockRedis {
  store = new Map<string, Entry>()

  private read(key: string): string | null {
    const e = this.store.get(key)
    if (!e) return null
    if (e.expireAt && Date.now() > e.expireAt) { this.store.delete(key); return null }
    return e.value
  }

  async get(key: string): Promise<string | null> { return this.read(key) }

  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    this.store.set(key, { value, expireAt: Date.now() + ttl * 1000 })
    return 'OK'
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.read(key) !== null) return null
    if (args.includes('XX') && this.read(key) === null) return null
    this.store.set(key, { value })
    return 'OK'
  }

  async del(key: string): Promise<number> { return this.store.delete(key) ? 1 : 0 }

  multi() {
    const ops: Array<() => any> = []
    const chain = {
      get: (key: string) => { ops.push(() => this.read(key)); return chain },
      del: (key: string) => { ops.push(() => (this.store.delete(key) ? 1 : 0)); return chain },
      exec: async () => ops.map(op => [null, op()]),
    }
    return chain
  }
}

const links = new Set<string>()
const prismaMock = {
  walletXLink: {
    findUnique: async ({ where }: any) => (links.has(where.xUserId) ? { xUserId: where.xUserId } : null),
  },
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const xs = require('../../../src/api/routes/xSignup')

describe('X-signup spend guarantees', () => {
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
    links.clear()
    xs._setRedisForTest(redis as any)
    xs._setPrismaForTest(prismaMock as any)
  })

  afterEach(() => {
    xs._setRedisForTest(null)
    xs._setPrismaForTest(null)
  })

  it('a token consumed twice concurrently yields one success', async () => {
    const token = await xs.issueXQualifiedToken('42', 'alice')
    const results = await Promise.all([
      xs.consumeXQualifiedToken(token),
      xs.consumeXQualifiedToken(token),
    ])
    expect(results.filter((r: any) => r !== null)).to.have.length(1)
  })

  it('a second token for the same xUserId cannot reserve a mint', async () => {
    const t1 = await xs.issueXQualifiedToken('42', 'alice')
    const t2 = await xs.issueXQualifiedToken('42', 'alice')
    const g1 = await xs.consumeXQualifiedToken(t1)
    const g2 = await xs.consumeXQualifiedToken(t2)
    expect(g1).to.not.equal(null)
    expect(g2).to.not.equal(null) // two distinct tokens: both consume fine
    expect(await xs.reserveXSpend(g1.xUserId, 'alice')).to.equal('ok')
    expect(await xs.reserveXSpend(g2.xUserId, 'alice')).to.equal('taken')
  })

  it('concurrent reservations for one xUserId: exactly one wins', async () => {
    const r = await Promise.all([xs.reserveXSpend('42', 'alice'), xs.reserveXSpend('42', 'alice'), xs.reserveXSpend('42', 'alice')])
    expect(r.filter((x: string) => x === 'ok')).to.have.length(1)
  })

  it('an xUserId already in WalletXLink is taken even with no Redis key', async () => {
    links.add('42')
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('taken')
  })

  it('releasing after a failed mint lets the same xUserId reserve again', async () => {
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('ok')
    await xs.releaseXSpend('42')
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('ok')
  })

  it('reservations for different xUserIds do not interfere', async () => {
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('ok')
    expect(await xs.reserveXSpend('43', 'alice')).to.equal('ok')
  })
  it('the reservation records the username, for an operator to check on chain', async () => {
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('ok')
    const marker = JSON.parse((await redis.get('sponsor:xspent:42'))!)
    expect(marker.username).to.equal('alice')
    expect(marker.at).to.be.a('number')
    expect(marker.txHash).to.equal(undefined)
  })

  it('a sent mint with an unknown outcome keeps the reservation and records the tx', async () => {
    expect(await xs.reserveXSpend('42', 'alice')).to.equal('ok')
    await xs.keepXSpendForSentTx('42', 'alice', '0xabc')
    const marker = JSON.parse((await redis.get('sponsor:xspent:42'))!)
    expect(marker).to.include({ username: 'alice', txHash: '0xabc' })
    expect(await xs.reserveXSpend('42', 'bob')).to.equal('taken')
  })

  it('recording a tx does not create a reservation that was not there', async () => {
    await xs.keepXSpendForSentTx('42', 'alice', '0xabc')
    expect(await redis.get('sponsor:xspent:42')).to.equal(null)
  })
})
