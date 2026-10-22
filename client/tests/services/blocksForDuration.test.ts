import { expect } from 'chai'
import { blocksForDuration } from '../../src/utils/rpcProvider'

// Minimal fake provider: a chain whose blocks are exactly `blockTimeSec`
// apart. `url` keys blocksForDuration's per-provider cache, so each case
// uses its own to avoid reading another case's measurement.
function makeProvider(url: string, head: number, blockTimeSec: number) {
  return {
    _getConnection() { return { url } },
    async getBlockNumber() { return head },
    async getBlock(n: number) { return { number: n, timestamp: Math.round(n * blockTimeSec) } },
  } as any
}

describe('blocksForDuration — Base Sepolia 2s → 200ms blocks', () => {
  it('sizes 10 minutes as ~3000 blocks (+25% margin) on a 200ms chain', async () => {
    const provider = makeProvider('http://fake/200ms', 50_000_000, 0.2)
    // 600s / 0.2s = 3000 blocks, × 1.25 safety margin.
    expect(await blocksForDuration(provider, 600)).to.equal(3750)
  })

  it('sizes the same 10 minutes as ~300 blocks on a 2s chain', async () => {
    const provider = makeProvider('http://fake/2s', 50_000_000, 2)
    expect(await blocksForDuration(provider, 600)).to.equal(375)
  })

  it('covers the 100s backstop floor with 625 blocks at 200ms, not the old fixed 50 (10s)', async () => {
    const provider = makeProvider('http://fake/200ms-floor', 50_000_000, 0.2)
    expect(await blocksForDuration(provider, 100)).to.equal(625)
  })
})
