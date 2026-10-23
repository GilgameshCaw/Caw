/**
 * The makeVerified* factories and the resilient rebuild must ask the RPC for
 * its chain id. Our providers are built with staticNetwork, so getNetwork()
 * answers with the expected chain without asking — the check has to go
 * through eth_chainId itself.
 *
 * Fake JSON-RPC servers on 127.0.0.1 only; nothing leaves the machine.
 */

import { expect } from 'chai'
import http from 'http'
import { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import {
  makeVerifiedJsonRpcProvider, makeVerifiedFallbackJsonRpcProvider,
  makeVerifiedWebSocketProvider, makeResilientHttpProvider, makeVerifiedResilientHttpProvider,
} from '../../src/utils/rpcProvider'

const SEPOLIA = 11155111
const SEPOLIA_HEX = '0xaa36a7'
const MAINNET_HEX = '0x1'

// chainId: the hex the server answers to eth_chainId; null answers it with a
// JSON-RPC error (an RPC that's up but can't serve the probe).
function answer(chainId: string | null, msg: any, counter: { n: number }) {
  if (msg.method === 'eth_chainId') {
    counter.n++
    if (chainId === null) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
    return { jsonrpc: '2.0', id: msg.id, result: chainId }
  }
  return { jsonrpc: '2.0', id: msg.id, result: '0x0' }
}

async function httpRpc(chainId: string | null) {
  const counter = { n: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d)).on('end', () => {
      const parsed = JSON.parse(body)
      const out = Array.isArray(parsed) ? parsed.map(m => answer(chainId, m, counter)) : answer(chainId, parsed, counter)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, counter, close: () => new Promise<void>(r => server.close(() => r())) }
}

async function wsRpc(chainId: string) {
  const counter = { n: 0 }
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', sock => {
    sock.on('message', data => {
      const parsed = JSON.parse(String(data))
      const out = Array.isArray(parsed) ? parsed.map(m => answer(chainId, m, counter)) : answer(chainId, parsed, counter)
      sock.send(JSON.stringify(out))
    })
  })
  await new Promise<void>(r => wss.on('listening', () => r()))
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return {
    url, counter, wss,
    close: () => new Promise<void>(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }),
  }
}

async function rejectionOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null } catch (e: any) { return String(e?.message ?? e) }
}

describe('rpcProvider — chain id verification', function () {
  this.timeout(20_000)

  let sepolia: Awaited<ReturnType<typeof httpRpc>>
  let mainnet: Awaited<ReturnType<typeof httpRpc>>
  let broken: Awaited<ReturnType<typeof httpRpc>>
  const quiet = console.warn
  const warnings: string[] = []

  before(async () => {
    sepolia = await httpRpc(SEPOLIA_HEX)
    mainnet = await httpRpc(MAINNET_HEX)
    broken = await httpRpc(null)
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  })
  after(async () => {
    console.warn = quiet
    await Promise.all([sepolia.close(), mainnet.close(), broken.close()])
  })
  beforeEach(() => { warnings.length = 0 })

  it('makeVerifiedJsonRpcProvider rejects an RPC on another chain', async () => {
    const before = mainnet.counter.n
    const err = await rejectionOf(makeVerifiedJsonRpcProvider(mainnet.url, SEPOLIA))
    expect(err).to.match(/^ChainIdMismatchError: expected 11155111 got 1 /)
    expect(mainnet.counter.n - before).to.equal(1)
  })

  it('makeVerifiedJsonRpcProvider accepts an RPC on the expected chain', async () => {
    const before = sepolia.counter.n
    expect(await rejectionOf(makeVerifiedJsonRpcProvider(sepolia.url, SEPOLIA))).to.equal(null)
    expect(sepolia.counter.n - before).to.equal(1)
  })

  it('a probe that fails is tolerated with a warning, as before', async () => {
    expect(await rejectionOf(makeVerifiedJsonRpcProvider(broken.url, SEPOLIA))).to.equal(null)
    expect(warnings.some(w => w.includes('chain-ID probe failed'))).to.equal(true)
  })

  it('makeVerifiedFallbackJsonRpcProvider rejects when a fallback URL is on another chain', async () => {
    expect(await rejectionOf(makeVerifiedFallbackJsonRpcProvider([mainnet.url], SEPOLIA)))
      .to.match(/^ChainIdMismatchError/)
    expect(await rejectionOf(makeVerifiedFallbackJsonRpcProvider([sepolia.url, mainnet.url], SEPOLIA)))
      .to.match(/^ChainIdMismatchError/)
    expect(await rejectionOf(makeVerifiedFallbackJsonRpcProvider([sepolia.url, sepolia.url], SEPOLIA)))
      .to.equal(null)
  })

  it('makeVerifiedWebSocketProvider rejects an RPC on another chain', async () => {
    const wrong = await wsRpc(MAINNET_HEX)
    const right = await wsRpc(SEPOLIA_HEX)
    try {
      expect(await rejectionOf(makeVerifiedWebSocketProvider(wrong.url, SEPOLIA)))
        .to.match(/^ChainIdMismatchError: expected 11155111 got 1 /)
      const ok = await makeVerifiedWebSocketProvider(right.url, SEPOLIA)
      expect(right.counter.n).to.be.greaterThan(0)
      ok.destroy()
    } finally {
      await Promise.all([wrong.close(), right.close()])
    }
  })

  it('a resilient rebuild is not promoted when a fallback URL is on another chain', async () => {
    const rejected = makeResilientHttpProvider([sepolia.url, mainnet.url], SEPOLIA, { label: 'test' })
    const kept = rejected.get()
    const errors: string[] = []
    const loud = console.error
    console.error = (...args: any[]) => { errors.push(args.join(' ')) }
    try {
      rejected.reportError(new Error('socket hang up'))
      await new Promise(r => setTimeout(r, 1_000))
    } finally {
      console.error = loud
    }
    expect(rejected.get()).to.equal(kept)
    expect(errors.some(e => e.includes('rebuild REJECTED'))).to.equal(true)

    // Control: the same rebuild over URLs on the right chain is promoted.
    const promoted = makeResilientHttpProvider([sepolia.url, sepolia.url], SEPOLIA, { label: 'test' })
    const old = promoted.get()
    promoted.reportError(new Error('socket hang up'))
    await new Promise(r => setTimeout(r, 1_000))
    expect(promoted.get()).to.not.equal(old)
  })

  it('makeVerifiedResilientHttpProvider probes every URL before the first provider is served', async () => {
    const s0 = sepolia.counter.n, m0 = mainnet.counter.n
    expect(await rejectionOf(makeVerifiedResilientHttpProvider([sepolia.url, mainnet.url], SEPOLIA, { label: 'test' })))
      .to.match(/^ChainIdMismatchError: expected 11155111 got 1 /)
    expect(sepolia.counter.n - s0).to.equal(1)
    expect(mainnet.counter.n - m0).to.equal(1)

    const ok = await makeVerifiedResilientHttpProvider([sepolia.url, sepolia.url], SEPOLIA, { label: 'test' })
    expect(ok.get()).to.not.equal(undefined)
    ok.destroy()
  })

  it('makeVerifiedResilientHttpProvider tolerates a failed probe with a warning', async () => {
    const ok = await makeVerifiedResilientHttpProvider([sepolia.url, broken.url], SEPOLIA, { label: 'test' })
    expect(warnings.some(w => w.includes('chain-ID probe failed'))).to.equal(true)
    ok.destroy()
  })
})
