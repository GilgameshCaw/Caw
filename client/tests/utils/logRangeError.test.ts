import { describe, it } from 'mocha'
import { expect } from 'chai'
import { shrinkWindow, errorText } from '../../src/utils/logRangeError'

// The error ethers v6 threw for a 1,000-block eth_getLogs against
// sepolia.base.org on 2026-10-27 (the cap was 200): the JSON-RPC error sits in
// `error`, and the same text is inside `message`.
function baseSepoliaCapError() {
  const e: any = new Error(
    'could not coalesce error (error={ "code": -32614, "message": "eth_getLogs is limited to a 200 range" }, payload={ "id": 4, "jsonrpc": "2.0", "method": "eth_getLogs" }, code=UNKNOWN_ERROR, version=6.13.0)',
  )
  e.code = 'UNKNOWN_ERROR'
  e.shortMessage = 'could not coalesce error'
  e.error = { code: -32614, message: 'eth_getLogs is limited to a 200 range' }
  return e
}

describe('shrinkWindow', () => {
  it('uses the cap the RPC names (the real sepolia.base.org error)', () => {
    expect(shrinkWindow(baseSepoliaCapError(), 50_000)).to.equal(200)
    expect(shrinkWindow(baseSepoliaCapError(), 1_000)).to.equal(200)
  })

  it('reads the cap from the nested error alone', () => {
    const e: any = new Error('could not coalesce error')
    e.error = { code: -32614, message: 'eth_getLogs is limited to a 500 range' }
    expect(shrinkWindow(e, 2_000)).to.equal(500)
  })

  it('reads a cap written with a thousands separator or "-block"', () => {
    expect(shrinkWindow(new Error('eth_getLogs is limited to a 10,000 range'), 50_000)).to.equal(10_000)
    expect(shrinkWindow(new Error('query is limited to 2000-block range'), 50_000)).to.equal(2_000)
  })

  it('reads the cap from the other public Base Sepolia RPCs (wording as returned on 2026-10-27)', () => {
    const rpcError = (message: string) => {
      const e: any = new Error(`could not coalesce error (error={ "code": -32001, "message": "${message}" }, code=UNKNOWN_ERROR)`)
      e.error = { code: -32001, message }
      return e
    }
    expect(shrinkWindow(rpcError('exceed maximum block range: 50000'), 100_000)).to.equal(50_000) // publicnode
    expect(shrinkWindow(rpcError('Block range too large: maximum allowed is 50 blocks on your current plan. Upgrade your subscription at https://nodies.app/pricing for larger'), 50_000)).to.equal(50) // nodies
    expect(shrinkWindow(rpcError('ranges over 10000 blocks are not supported on free plan'), 50_000)).to.equal(10_000) // drpc
  })

  it('halves when the range is called too wide without a number', () => {
    expect(shrinkWindow(new Error('server response 413 Payload Too Large'), 50_000)).to.equal(25_000)
    expect(shrinkWindow(new Error('query exceeds max block range'), 1_001)).to.equal(500)
    expect(shrinkWindow(new Error('query returned more than 10000 results'), 4_000)).to.equal(2_000)
  })

  it('halves from the HTTP body when the message has nothing', () => {
    const e: any = new Error('bad response')
    e.info = { responseStatus: '413 Payload Too Large', responseBody: '{"error":"range too large"}' }
    expect(shrinkWindow(e, 8)).to.equal(4)
  })

  it('does not grow: a cap at or above the window falls back to halving', () => {
    expect(shrinkWindow(new Error('eth_getLogs is limited to a 5000 range'), 2_000)).to.equal(1_000)
  })

  it('stops at one block', () => {
    expect(shrinkWindow(baseSepoliaCapError(), 1)).to.equal(undefined)
    expect(shrinkWindow(new Error('range too large'), 1)).to.equal(undefined)
    expect(shrinkWindow(new Error('range too large'), 2)).to.equal(1)
  })

  it('does not shrink for anything that is not about the range', () => {
    for (const msg of [
      '429 Too Many Requests',
      'could not coalesce error (error={ "code": -32005, "message": "rate limit exceeded" }, payload={ "id": 413 })',
      'connect ECONNREFUSED 127.0.0.1:1',
      'missing response',
      'request timeout',
    ]) {
      expect(shrinkWindow(new Error(msg), 50_000), msg).to.equal(undefined)
    }
    expect(shrinkWindow(undefined, 50_000)).to.equal(undefined)
    expect(shrinkWindow('boom', 50_000)).to.equal(undefined)
  })

  it('errorText follows nested errors without looping', () => {
    const a: any = new Error('outer')
    a.error = a
    a.cause = { message: 'inner' }
    expect(errorText(a)).to.contain('outer').and.to.contain('inner')
  })
})
