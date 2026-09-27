/**
 * DELETE /api/sessions: the per-owner budget must only be charged for a
 * signature that verifies, and the per-IP budget must key on req.ip (which
 * honours trust proxy) rather than a client-controlled X-Forwarded-For entry.
 *
 * Uses a local JSON-RPC stub for eth_call so the real getContract() /
 * staticCall path runs, and Redis db 15 (REDIS_URL) so nothing else is touched.
 * Run with mocha --exit: the router's imports keep Redis/DB connections open.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import http from 'http'
import request from 'supertest'
import Redis from 'ioredis'
import { Wallet, id } from 'ethers'

type Mode = 'revert' | 'ok' | 'down' | 'bare' | 'nosession'
let mode: Mode = 'revert'
let rpc: http.Server
let app: any
let redis: Redis

const BAD_SIG = id('BadSig()').slice(0, 10)
const NO_SESSION = id('NoSession()').slice(0, 10)
const SIG = '0x' + '11'.repeat(64) + '1b'
const rand = () => Wallet.createRandom().address
let ipCounter = 0
const freshIp = () => `203.0.113.${(++ipCounter % 250) + 1}`
const ownerKey = (o: string) => `revoke_ratelimit:owner:${o.toLowerCase()}`

function handle(body: any) {
  const { id: rid, method } = body
  if (method === 'eth_chainId') return { jsonrpc: '2.0', id: rid, result: '0x14a34' }
  if (method === 'net_version') return { jsonrpc: '2.0', id: rid, result: '84532' }
  if (method === 'eth_call') {
    if (mode === 'ok') return { jsonrpc: '2.0', id: rid, result: '0x' }
    if (mode === 'bare') return { jsonrpc: '2.0', id: rid, error: { code: 3, message: 'execution reverted' } }
    const data = mode === 'nosession' ? NO_SESSION : BAD_SIG
    return { jsonrpc: '2.0', id: rid, error: { code: 3, message: 'execution reverted', data } }
  }
  return { jsonrpc: '2.0', id: rid, error: { code: -32601, message: 'stub: ' + method } }
}

describe('DELETE /api/sessions rate limiting', function () {
  this.timeout(30000)

  before(async () => {
    rpc = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => (raw += c))
      req.on('end', () => {
        const parsed = JSON.parse(raw)
        const isEthCall = (Array.isArray(parsed) ? parsed : [parsed]).some((p: any) => p.method === 'eth_call')
        if (mode === 'down' && isEthCall) { res.statusCode = 500; return res.end('boom') }
        const out = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      })
    })
    await new Promise<void>(r => rpc.listen(0, '127.0.0.1', () => r()))
    const port = (rpc.address() as any).port
    process.env.L2_RPC_URL_HTTP = `http://127.0.0.1:${port}`
    process.env.VALIDATOR_PRIVATE_KEY = Wallet.createRandom().privateKey
    process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/15'
    if (!process.env.REDIS_URL.endsWith('/15')) throw new Error('refusing to run outside Redis db 15')
    redis = new Redis(process.env.REDIS_URL)
    await redis.flushdb()
    const express = require('express')
    app = express()
    app.set('trust proxy', 'loopback')
    app.use(express.json())
    app.use('/api/sessions', require('../../../src/api/routes/sessions').default)
  })

  beforeEach(async () => { mode = 'revert'; await redis.flushdb() })
  after(async () => { await redis.flushdb(); await redis.quit(); rpc.close() })

  const del = (owner: string, xff: string) =>
    request(app).delete('/api/sessions').set('X-Forwarded-For', xff)
      .send({ owner, sessionKey: rand(), signature: SIG })

  it('does not charge the owner budget for signatures that fail verification', async () => {
    const owner = rand()
    for (let i = 0; i < 12; i++) {
      const res = await del(owner, freshIp())
      expect(res.status, `request ${i + 1}`).to.equal(400)
    }
    expect(await redis.llen(ownerKey(owner))).to.equal(0)
  })

  it('charges the owner budget once for a signature that verifies', async () => {
    mode = 'ok'
    const owner = rand()
    const res = await del(owner, freshIp())
    expect([200, 202]).to.include(res.status)
    expect(await redis.llen(ownerKey(owner))).to.equal(1)
  })

  it('keys the IP budget on the trusted address, not a forged leftmost X-Forwarded-For', async () => {
    const realClient = '198.51.100.7'
    let last = 0
    for (let i = 0; i < 31; i++) {
      const res = await del(rand(), `10.9.${i}.1, ${realClient}`)
      last = res.status
      if (i < 30) expect(res.status, `request ${i + 1}`).to.equal(400)
    }
    expect(last).to.equal(429)
  })

  it('answers 503 and charges nothing when the RPC is unavailable', async () => {
    mode = 'down'
    const owner = rand()
    const res = await del(owner, freshIp())
    expect(res.status).to.equal(503)
    expect(await redis.llen(ownerKey(owner))).to.equal(0)
  })

  it('answers 400, not 503, for a well-formed signature whose value is not canonical', async () => {
    const owner = rand()
    const nonCanonicalS = '0x' + '11'.repeat(32) + '80' + '11'.repeat(31) + '1b'
    const res = await request(app).delete('/api/sessions').set('X-Forwarded-For', freshIp())
      .send({ owner, sessionKey: rand(), signature: nonCanonicalS })
    expect(res.status).to.equal(400)
    expect(await redis.llen(ownerKey(owner))).to.equal(0)
  })

  it('answers 400 for a NoSession revert (already revoked) and charges nothing', async () => {
    mode = 'nosession'
    const owner = rand()
    const res = await del(owner, freshIp())
    expect(res.status).to.equal(400)
    expect(await redis.llen(ownerKey(owner))).to.equal(0)
  })

  it('answers 503, not 400, for a revert that carries no data', async () => {
    mode = 'bare'
    const owner = rand()
    const res = await del(owner, freshIp())
    expect(res.status).to.equal(503)
    expect(await redis.llen(ownerKey(owner))).to.equal(0)
  })
})
