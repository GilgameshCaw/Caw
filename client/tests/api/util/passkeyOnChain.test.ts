/**
 * verifyPasskeyAssertionOnChain: what counts as "the contract said no" and what
 * counts as "we could not ask".
 *
 * The function's own comment, and the 503 branches of its callers
 * (auth.ts verify-passkey, wallet-blob.ts prf-write / retrieve), rely on it
 * returning false for a bad assertion and throwing when the L1 RPC cannot be
 * used. ethers reports every JSON-RPC error answer as CALL_EXCEPTION, so
 * "header not found" or a rate limit looks like a revert unless the RPC error
 * itself is read. These tests put a local JSON-RPC server behind the real
 * provider and check both sides.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import http from 'node:http'
import { inspect } from 'node:util'
import type { AddressInfo } from 'node:net'
import { isErc1271Valid } from '../../../src/api/util/erc1271'

const API_KEY = 'SECRETKEY123'
const MARKER = 'R01_UPSTREAM_TEXT_MARKER'
const MAGIC = '0x1626ba7e' + '00'.repeat(28)
const REVERT_REASON_BAD =
  '0x08c379a0' + '00'.repeat(31) + '20' + '00'.repeat(31) + '03' + '626164' + '00'.repeat(29)

let mode = 'magic'
let server: http.Server
let verify: (a: string, c: `0x${string}`, s: `0x${string}`) => Promise<boolean>

const ADDR = '0x' + '11'.repeat(20)
const CHALLENGE = ('0x' + '22'.repeat(32)) as `0x${string}`
const SIG = ('0x' + '33'.repeat(40)) as `0x${string}`

describe('verifyPasskeyAssertionOnChain', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (mode === 'http500') { res.statusCode = 500; res.end('boom'); return }
        if (mode === 'html') { res.setHeader('content-type', 'text/html'); res.end('<html>bad gateway</html>'); return }
        if (mode === 'drop') { req.socket.destroy(); return }
        let id = 1
        try { id = JSON.parse(body).id } catch { /* keep 1 */ }
        const send = (o: object) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...o })) }
        switch (mode) {
          case 'magic': return send({ result: MAGIC })
          case 'wrong-value': return send({ result: '0xffffffff' + '00'.repeat(28) })
          case 'empty': return send({ result: '0x' })
          case 'short': return send({ result: '0x1626' })
          case 'revert-code3': return send({ error: { code: 3, message: 'execution reverted' } })
          case 'revert-reason': return send({ error: { code: 3, message: 'execution reverted: bad', data: REVERT_REASON_BAD } })
          case 'revert-32000': return send({ error: { code: -32000, message: 'execution reverted' } })
          case 'node-error': return send({ error: { code: -32000, message: 'header not found' } })
          case 'rate-limit': return send({ error: { code: -32005, message: 'rate limit exceeded' } })
          case 'node-wording': return send({ error: { code: -32603, message: 'upstream request unavailable; prior check execution reverted' } })
          case 'node-text-data': return send({ error: { code: -32603, message: 'upstream reverted the diagnostic request', data: '0x12345678' } })
          case 'node-data': return send({ error: { code: -32603, message: 'header not found', data: '0x12345678' } })
          case 'node-data-object': return send({ error: { code: -32603, message: 'upstream unavailable', data: { detail: 'maintenance' } } })
          case 'unseen-revert': return send({ error: { code: -32015, message: 'VM Exception while processing transaction: revert' } })
          case 'marker-message': return send({ error: { code: -32000, message: 'header not found ' + MARKER, data: '0x' + '12'.repeat(4) } })
          default: return send({ error: { code: -32603, message: 'unexpected mode ' + mode } })
        }
      })
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    // The path stands for an API key in a provider URL.
    process.env.L1_RPC_URL_HTTP = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v2/' + API_KEY
    process.env.L1_CHAIN_ID = '11155111'

    // The module opens its own Redis client when it is imported; keep it from connecting.
    const ioredis: any = await import('ioredis')
    const Redis = ioredis.default ?? ioredis
    const realConnect = Redis.prototype.connect
    Redis.prototype.connect = async () => {}
    try {
      verify = (await import('../../../src/api/util/passkeyVerify')).verifyPasskeyAssertionOnChain
    } finally {
      Redis.prototype.connect = realConnect
    }
  })

  after(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
  })

  const ask = (m: string) => { mode = m; return verify(ADDR, CHALLENGE, SIG) }

  describe('the contract answers', () => {
    it('returns true for the ERC-1271 magic value', async () => {
      expect(await ask('magic')).to.equal(true)
    })

    for (const m of ['wrong-value', 'empty', 'short', 'revert-code3', 'revert-reason', 'revert-32000']) {
      it(`returns false for an invalid assertion (${m})`, async () => {
        expect(await ask(m)).to.equal(false)
      })
    }
  })

  describe('the RPC cannot be used: the error reaches the caller', () => {
    for (const [m, what] of [
      ['node-error', 'a JSON-RPC error that is not a revert (header not found)'],
      ['rate-limit', 'a JSON-RPC rate limit answer'],
      ['http500', 'an HTTP 500'],
      ['html', 'a body that is not JSON'],
      ['drop', 'a connection closed without an answer'],
      ['node-wording', 'a node error whose text contains "execution reverted" in the middle'],
      ['node-text-data', 'a node error with revert-like text and hex data'],
      ['node-data', 'a node error (header not found) with hex data'],
      ['node-data-object', 'a node error with object data'],
      ['unseen-revert', 'a revert in a format that is not recognised'],
      ['marker-message', 'a node error whose text carries a marker'],
    ] as const) {
      it(`throws on ${what}`, async () => {
        let thrown: any = null
        try { await ask(m) } catch (e) { thrown = e }
        expect(thrown, `${m} must not be reported as an invalid signature`).to.not.equal(null)
        // The callers log what they catch: it must not carry the provider URL.
        expect(inspect(thrown, { depth: 5 })).to.not.include(API_KEY)
        expect(inspect(thrown, { depth: 5 })).to.not.include(MARKER)
      })
    }
  })
})

describe('isErc1271Valid: what an error has to show to count as the contract saying no', () => {
  const failing = (err: object) => ({ isValidSignature: async () => { throw err } }) as any
  const ask = (err: object) => isErc1271Valid(failing(err), '0x' + '71'.repeat(32), '0x83')
  const rejects = async (err: object) => { try { await ask(err) } catch (e) { return e as any } throw new Error('expected an error') }

  it('a decoded revert reason counts', async () => {
    expect(await ask({ code: 'CALL_EXCEPTION', revert: { name: 'Error', args: ['no'] } })).to.equal(false)
  })

  it('hex data alone does not count', async () => {
    const e = await rejects({ code: 'CALL_EXCEPTION', data: '0x12345678', shortMessage: MARKER })
    expect(e.code).to.equal('CALL_EXCEPTION')
  })

  it('a BAD_DATA that did not come from decoding this call does not count', async () => {
    const e = await rejects({ code: 'BAD_DATA', shortMessage: MARKER })
    expect(e.code).to.equal('BAD_DATA')
    expect(await ask({ code: 'BAD_DATA', info: { method: 'isValidSignature' }, value: '0x' })).to.equal(false)
  })

  it('the thrown error carries a fixed message and an allow-listed code only', async () => {
    for (const err of [
      { code: MARKER, shortMessage: MARKER, message: MARKER },
      { code: 'SERVER_ERROR', shortMessage: MARKER, message: MARKER, info: { requestUrl: 'http://x/' + MARKER } },
      { code: 'CALL_EXCEPTION', shortMessage: MARKER, info: { error: { code: -32000, message: MARKER } } },
    ]) {
      const e = await rejects(err)
      expect(inspect(e, { depth: 5 })).to.not.include(MARKER)
      expect(e.message).to.match(/^L1 RPC call failed \([A-Z_]+\)$/)
    }
    expect((await rejects({ code: MARKER })).code).to.equal('UNKNOWN')
  })
})
