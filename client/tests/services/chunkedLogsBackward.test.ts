import { expect } from 'chai'
import { scanLogsBackward, findContractDeployBlock } from '../../src/utils/chunkedLogs'

// Minimal fake provider: getLogs returns any seeded events whose block falls
// in [fromBlock, toBlock]; getCode returns code at/after a deploy block. Only
// the surface scanLogsBackward / findContractDeployBlock actually call.
function makeProvider(opts: {
  head: number
  events: { block: number }[]
  failRanges?: Array<[number, number]> // getLogs throws if the requested range overlaps any of these
  deployBlock?: number
}) {
  const { head, events, failRanges = [], deployBlock = 0 } = opts
  return {
    async getBlockNumber() { return head },
    async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      for (const [lo, hi] of failRanges) {
        if (fromBlock <= hi && toBlock >= lo) throw new Error(`RPC range error ${fromBlock}..${toBlock}`)
      }
      return events
        .filter(e => e.block >= fromBlock && e.block <= toBlock)
        .map(e => ({ blockNumber: e.block, topics: ['0xtopic'], logIndex: 0 })) as any
    },
    async getCode(_addr: string, block: number) {
      return block >= deployBlock ? '0xdeadbeef' : '0x'
    },
  } as any
}

describe('scanLogsBackward — sparse-scatter fix', () => {
  const ADDR = '0xManager'
  const TOPICS = ['0xtopic']

  it('DEFAULT (early-bail) truncates when events are scattered across an empty gap', async () => {
    // Two clusters with a >chunk-sized empty gap between them. chunk=10k:
    // recent cluster at ~95k, older registrations at ~5k, gap 10k..90k empty.
    const provider = makeProvider({
      head: 100_000,
      events: [{ block: 95_000 }, { block: 5_000 }],
    })
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, { chunkBlocks: 10_000 })
    // The first empty window after the 95k cluster bails the walk — the 5k
    // registration is never reached. This is the bug the fix addresses.
    expect(logs.map((l: any) => l.blockNumber)).to.deep.equal([95_000])
  })

  it('stopOnEmptyWindow:false + fromBlock floor reaches every scattered event', async () => {
    const provider = makeProvider({
      head: 100_000,
      events: [{ block: 95_000 }, { block: 5_000 }],
    })
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, {
      chunkBlocks: 10_000,
      stopOnEmptyWindow: false,
      fromBlock: 0,
      maxWindows: 20,
    })
    const blocks = logs.map((l: any) => l.blockNumber).sort((a: number, b: number) => b - a)
    expect(blocks).to.deep.equal([95_000, 5_000])
  })

  it('default maxWindows ceiling strands the oldest events on a deep range', async () => {
    // Event beyond 200k blocks back (20 windows × 10k) is out of reach by the
    // ceiling alone, even without any empty-window bail.
    const provider = makeProvider({
      head: 300_000,
      events: [{ block: 299_000 }, { block: 20_000 }],
    })
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, {
      chunkBlocks: 10_000,
      stopOnEmptyWindow: false, // isolate the ceiling effect from the bail
    })
    // Only the recent event is within the default 20-window (200k) reach.
    expect(logs.map((l: any) => l.blockNumber)).to.deep.equal([299_000])
  })

  it('sizing maxWindows to the range recovers the oldest events', async () => {
    const provider = makeProvider({
      head: 300_000,
      events: [{ block: 299_000 }, { block: 20_000 }],
    })
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, {
      chunkBlocks: 10_000,
      stopOnEmptyWindow: false,
      fromBlock: 0,
      maxWindows: 32,
    })
    const blocks = logs.map((l: any) => l.blockNumber).sort((a: number, b: number) => b - a)
    expect(blocks).to.deep.equal([299_000, 20_000])
  })

  it('onError fires and scan does not silently report empty on RPC failure', async () => {
    // Every getLogs call fails (both the full window and the halved retry).
    const provider = makeProvider({
      head: 100_000,
      events: [{ block: 50_000 }],
      failRanges: [[0, 100_000]],
    })
    const seen: Array<{ from: number; to: number }> = []
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, {
      chunkBlocks: 10_000,
      stopOnEmptyWindow: false,
      onError: (from, to) => seen.push({ from, to }),
    })
    expect(logs).to.have.length(0)          // no events recoverable
    expect(seen.length).to.be.greaterThan(0) // but the failure was surfaced, not swallowed
  })

  it('default behavior is unchanged for existing callers (early-bail still on)', async () => {
    // A caller passing no new options gets the exact old semantics: bail on the
    // first empty window after seeing events.
    const provider = makeProvider({
      head: 100_000,
      events: [{ block: 95_000 }, { block: 5_000 }],
    })
    const logs = await scanLogsBackward(provider, ADDR, TOPICS, { chunkBlocks: 10_000 })
    expect(logs.map((l: any) => l.blockNumber)).to.deep.equal([95_000])
  })

  it('delayMs (default 0) does not add wall-clock time for existing callers', async () => {
    const provider = makeProvider({
      head: 30_000,
      events: [{ block: 25_000 }, { block: 15_000 }, { block: 5_000 }],
    })
    const start = Date.now()
    await scanLogsBackward(provider, ADDR, TOPICS, { chunkBlocks: 10_000, fromBlock: 0, stopOnEmptyWindow: false })
    const elapsed = Date.now() - start
    // 3 windows, no delayMs specified -- should complete near-instantly
    // (fake provider has no real I/O latency). Generous bound to avoid
    // flaking on a loaded CI box while still catching a regression that
    // accidentally defaults delayMs to something nonzero.
    expect(elapsed).to.be.lessThan(50)
  })

  it('delayMs spaces out windows by the given amount', async () => {
    const provider = makeProvider({
      head: 30_000,
      events: [{ block: 25_000 }, { block: 15_000 }, { block: 5_000 }],
    })
    const start = Date.now()
    await scanLogsBackward(provider, ADDR, TOPICS, {
      chunkBlocks: 10_000,
      fromBlock: 0,
      stopOnEmptyWindow: false,
      delayMs: 30,
    })
    const elapsed = Date.now() - start
    // 3 windows -> 2 gaps between them (no delay before the first window,
    // per the i > 0 guard) -> at least ~60ms of enforced delay.
    expect(elapsed).to.be.gte(55)
  })
})

describe('findContractDeployBlock', () => {
  it('binary-searches the earliest block with code', async () => {
    const provider = makeProvider({ head: 100_000, events: [], deployBlock: 42_000 })
    const block = await findContractDeployBlock(provider, '0xManager', 100_000)
    expect(block).to.equal(42_000)
  })

  it('returns 0 when the contract has no code at head', async () => {
    const provider = makeProvider({ head: 100_000, events: [], deployBlock: 200_000 })
    const block = await findContractDeployBlock(provider, '0xManager', 100_000)
    expect(block).to.equal(0)
  })
})
