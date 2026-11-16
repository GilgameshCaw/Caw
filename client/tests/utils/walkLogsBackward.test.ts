import { describe, it } from 'mocha'
import { expect } from 'chai'
import { walkLogsBackward, WalkLimitError } from '../../src/utils/walkLogsBackward'

// The error ethers v6 threw for an over-wide eth_getLogs on sepolia.base.org
// (cap 200 on 2026-10-27); same shape as in logRangeError.test.ts.
function capError(cap: number) {
  const e: any = new Error(`could not coalesce error (error={ "code": -32614, "message": "eth_getLogs is limited to a ${cap} range" }, code=UNKNOWN_ERROR)`)
  e.error = { code: -32614, message: `eth_getLogs is limited to a ${cap} range` }
  return e
}

// A chain with one event at each block in `eventBlocks`; fetchWindow rejects
// windows wider than `cap` blocks and records every call.
function fakeChain(eventBlocks: number[], cap = Infinity, failWith?: Error) {
  const calls: Array<[number, number]> = []
  const fetchWindow = async (from: number, to: number) => {
    calls.push([from, to])
    if (failWith) throw failWith
    if (to - from + 1 > cap) throw capError(cap)
    return eventBlocks.filter(b => b >= from && b <= to)
  }
  return { calls, fetchWindow }
}

describe('walkLogsBackward', () => {
  it('walks back in contiguous windows and returns the events oldest first', async () => {
    const chain = fakeChain([5, 12, 18, 29, 31])
    const seen: number[][] = []
    const r = await walkLogsBackward({
      latest: 39, chunk: 10, fetchWindow: chain.fetchWindow,
      onWindow: ev => { seen.push(ev); return false },
    })
    expect(chain.calls).to.deep.equal([[30, 39], [20, 29], [10, 19], [0, 9]])
    expect(seen).to.deep.equal([[31], [29], [12, 18], [5]])
    expect(r.events).to.deep.equal([5, 12, 18, 29, 31])
  })

  it('stops as soon as onWindow says it has enough', async () => {
    const chain = fakeChain([5, 12, 18, 29, 31])
    let count = 0
    const r = await walkLogsBackward({
      latest: 39, chunk: 10, fetchWindow: chain.fetchWindow,
      onWindow: ev => { count += ev.length; return count >= 3 },
    })
    expect(chain.calls).to.deep.equal([[30, 39], [20, 29], [10, 19]])
    expect(r.events).to.deep.equal([12, 18, 29, 31])
  })

  it('shrinks to the cap the RPC names, retries the same range, and keeps the size', async () => {
    const chain = fakeChain([1, 150, 410, 799], 200)
    const shrinks: Array<[number, number]> = []
    const r = await walkLogsBackward({
      latest: 799, chunk: 50_000, fetchWindow: chain.fetchWindow,
      onWindow: () => false, onShrink: (a, b) => shrinks.push([a, b]),
    })
    expect(shrinks).to.deep.equal([[50_000, 200]])
    // first the rejected 0..799 window, then 200-block windows over the same range
    expect(chain.calls).to.deep.equal([[0, 799], [600, 799], [400, 599], [200, 399], [0, 199]])
    expect(r.events).to.deep.equal([1, 150, 410, 799])
    expect(r.chunk).to.equal(200)
  })

  it('misses no block and reads none twice after a shrink', async () => {
    const all = Array.from({ length: 1000 }, (_, i) => i)
    const chain = fakeChain(all, 64)
    const r = await walkLogsBackward({ latest: 999, chunk: 1000, fetchWindow: chain.fetchWindow, onWindow: () => false })
    expect(r.events).to.deep.equal(all)
  })

  it('never reads below the floor', async () => {
    const chain = fakeChain([2, 7, 12], Infinity)
    const r = await walkLogsBackward({
      latest: 19, floor: 8, chunk: 5, fetchWindow: chain.fetchWindow, onWindow: () => false,
    })
    expect(Math.min(...chain.calls.map(c => c[0]))).to.equal(8)
    expect(r.events).to.deep.equal([12])
  })

  it('aborts on a failure that is not about the range, without a partial result', async () => {
    const chain = fakeChain([1, 2, 3], Infinity, new Error('429 Too Many Requests'))
    let threw: any
    try {
      await walkLogsBackward({ latest: 9, chunk: 5, fetchWindow: chain.fetchWindow, onWindow: () => false })
    } catch (e) { threw = e }
    expect(threw).to.be.instanceOf(Error)
    expect(threw.message).to.contain('429')
    expect(chain.calls).to.have.length(1)
  })

  it('throws WalkLimitError once maxBlocks are read without enough events', async () => {
    const chain = fakeChain([])
    let threw: any
    try {
      await walkLogsBackward({ latest: 39, chunk: 10, maxBlocks: 25, fetchWindow: chain.fetchWindow, onWindow: () => false })
    } catch (e) { threw = e }
    expect(threw).to.be.instanceOf(WalkLimitError)
    expect(threw.covered).to.equal(30)
    expect(threw.maxBlocks).to.equal(25)
    expect(chain.calls).to.deep.equal([[30, 39], [20, 29], [10, 19]])
  })

  it('does not throw when the last window within the limit has enough', async () => {
    const chain = fakeChain([12])
    const r = await walkLogsBackward({ latest: 39, chunk: 10, maxBlocks: 25, fetchWindow: chain.fetchWindow, onWindow: ev => ev.length > 0 })
    expect(r.events).to.deep.equal([12])
    expect(chain.calls).to.have.length(3)
  })

  it('does not throw when the floor is reached inside the limit', async () => {
    const chain = fakeChain([])
    const r = await walkLogsBackward({ latest: 39, floor: 20, chunk: 10, maxBlocks: 25, fetchWindow: chain.fetchWindow, onWindow: () => false })
    expect(r.events).to.deep.equal([])
    expect(chain.calls).to.deep.equal([[30, 39], [20, 29]])
  })

  it('counts the limit in blocks, not windows, after the window shrinks', async () => {
    const chain = fakeChain([], 5)
    let threw: any
    try {
      await walkLogsBackward({ latest: 99, chunk: 50, maxBlocks: 20, fetchWindow: chain.fetchWindow, onWindow: () => false })
    } catch (e) { threw = e }
    expect(threw).to.be.instanceOf(WalkLimitError)
    expect(threw.covered).to.equal(20)
  })

  it('throws when the window cannot shrink any further', async () => {
    const e: any = new Error('range too large')
    const chain = fakeChain([], Infinity, e)
    let threw: any
    try {
      await walkLogsBackward({ latest: 9, chunk: 4, fetchWindow: chain.fetchWindow, onWindow: () => false })
    } catch (err) { threw = err }
    expect(threw).to.equal(e)
    expect(chain.calls.map(c => c[1] - c[0] + 1)).to.deep.equal([4, 2, 1])
  })
})
