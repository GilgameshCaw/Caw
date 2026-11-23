/**
 * syncOwnerSetEvents and runOwnerSetSync: the L2 OwnerSet loop, with a fake provider and contract
 * and the Prisma calls replaced on the model delegates (no database, no RPC).
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

describe('syncOwnerSetEvents', function () {
  this.timeout(30000)

  let sync: (p: any, f?: any) => Promise<void>
  let run: (p: any, onError?: (e: unknown) => void, f?: any) => Promise<void>
  let failDb = false
  let chainData: Map<string, any>
  let owners: Map<number, any>
  let firstRaw: any
  let floorFlags: any[]
  let ranges: Array<[number, number]>
  let restore: () => void = () => {}

  const A = '0xaaaa000000000000000000000000000000000001'
  const B = '0xbbbb000000000000000000000000000000000002'
  const ev = (tokenId: number, newOwner: string, blockNumber: number, index = 0) =>
    ({ args: { tokenId, newOwner }, blockNumber, index })
  const L2 = 84532
  const flag = (filled: boolean, chainId = L2, networkId = 1) => ({ key: `raw-events-gatherer:${chainId}:${networkId}:floor-filled`, value: { filled } })
  const provider = (head: number) => ({ getBlockNumber: async () => head, getNetwork: async () => ({ chainId: BigInt(L2) }) })
  const factory = (events: any[], failOn?: number) => () => ({
    filters: { OwnerSet: () => 'f' },
    queryFilter: async (_f: any, from: number, to: number) => {
      ranges.push([from, to])
      if (failOn !== undefined && from <= failOn && failOn <= to) throw new Error('rpc down')
      return events.filter(e => e.blockNumber >= from && e.blockNumber <= to)
    },
  })

  before(async () => {
    const { prisma } = await import('../../../src/prismaClient')
    const mod = await import('../../../src/services/ChainSyncService/ownerSetSync')
    sync = mod.syncOwnerSetEvents
    run = mod.runOwnerSetSync
    const restores: Array<() => void> = []
    const stub = (m: string, method: string, fn: (a: any) => any) => {
      const model: any = (prisma as any)[m]
      const had = Object.prototype.hasOwnProperty.call(model, method)
      const prev = model[method]
      model[method] = fn
      restores.push(() => { if (had) model[method] = prev; else delete model[method] })
    }
    stub('rawEvent', 'findFirst', async (a: any) => (firstRaw && (a?.where?.chainId === undefined || a.where.chainId === firstRaw.chainId)) ? firstRaw : null)
    stub('chainData', 'findMany', async (a: any) => floorFlags.filter(f => f.key.startsWith(a.where.key.startsWith)))
    stub('chainData', 'findUnique', async (a: any) => {
      if (failDb) throw new Error('relation "TokenOwnerSince" does not exist')
      return chainData.get(a.where.key) ?? null
    })
    stub('chainData', 'upsert', async (a: any) => { chainData.set(a.where.key, { value: a.update.value }); return {} })
    stub('tokenOwnerSince', 'findUnique', async (a: any) => owners.get(a.where.tokenId) ?? null)
    stub('tokenOwnerSince', 'upsert', async (a: any) => {
      const cur = owners.get(a.where.tokenId)
      owners.set(a.where.tokenId, cur ? { ...cur, ...a.update } : { ...a.create })
      return {}
    })
    restore = () => restores.forEach(r => r())
  })

  after(() => restore())

  beforeEach(() => { failDb = false; chainData = new Map(); owners = new Map(); ranges = []; firstRaw = { chainId: L2, blockNumber: 40_001n }; floorFlags = [flag(true)] })

  it('with no cursor it starts just before the earliest indexed action and records the events it finds', async () => {
    await sync(provider(50_000), factory([ev(7, A, 45_000), ev(7, B, 49_000, 2)]))
    expect(ranges[0][0]).to.equal(40_001)
    expect(owners.get(7)).to.deep.include({ owner: B, sinceBlock: 49_000n, sinceLogIndex: 2 })
    expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(50_000)
  })

  it('with no cursor and no indexed action it does not start, and sets no cursor', async () => {
    firstRaw = null
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    expect(ranges).to.have.length(0)
    expect(chainData.size).to.equal(0)
  })

  it('with no cursor it waits until the raw-event history is filled down to its floor, and sets no cursor', async () => {
    floorFlags = []
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    floorFlags = [flag(false)]
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    expect(ranges).to.have.length(0)
    expect(chainData.size).to.equal(0)
    floorFlags = [flag(true)]
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    expect(ranges).to.have.length.greaterThan(0)
    expect(owners.get(7)?.owner).to.equal(A)
  })

  it('another chain\'s history-fill flag and raw events do not set the start', async () => {
    // a flag for another chain, filled; this chain's history is not filled yet
    floorFlags = [flag(true, 1), flag(false)]
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    expect(ranges).to.have.length(0)
    expect(chainData.size).to.equal(0)
    // this chain's is filled, but the only raw event on record is another chain's
    floorFlags = [flag(true)]
    firstRaw = { chainId: 1, blockNumber: 10n }
    await sync(provider(50_000), factory([ev(7, A, 45_000)]))
    expect(ranges).to.have.length(0)
    expect(chainData.size).to.equal(0)
  })

  it('a long way behind it takes 25 chunks per run and carries on from there on the next run', async () => {
    chainData.set('l2_owner_set_last_synced_block', { value: { block: 0 } })
    await sync(provider(1_000_000), factory([]))
    expect(ranges).to.have.length(25)
    expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(50_000)
    ranges = []
    await sync(provider(1_000_000), factory([]))
    expect(ranges[0][0]).to.equal(50_001)
  })

  it('scans in chunks of 2000 blocks from the cursor', async () => {
    chainData.set('l2_owner_set_last_synced_block', { value: { block: 1000 } })
    await sync(provider(5500), factory([]))
    expect(ranges).to.deep.equal([[1001, 3000], [3001, 5000], [5001, 5500]])
  })

  it('a failed range leaves the cursor where it was, so the next tick retries it', async () => {
    chainData.set('l2_owner_set_last_synced_block', { value: { block: 1000 } })
    let err: any
    try { await sync(provider(5500), factory([ev(7, A, 1500)], 4000)) } catch (e) { err = e }
    expect(err?.message).to.equal('rpc down')
    expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(3000)
    expect(owners.get(7)?.owner).to.equal(A)
    // the next tick: same events again, nothing breaks
    ranges = []
    await sync(provider(5500), factory([ev(7, A, 1500)]))
    expect(ranges[0]).to.deep.equal([3001, 5000])
    expect(owners.get(7)?.owner).to.equal(A)
  })

  it('skips a range the RPC has pruned, so it does not hold every later range', async () => {
    chainData.set('l2_owner_set_last_synced_block', { value: { block: 0 } })
    const f = () => ({
      filters: { OwnerSet: () => 'f' },
      queryFilter: async (_f: any, from: number, to: number) => {
        ranges.push([from, to])
        if (to <= 4000) throw new Error('code 4444 pruned history unavailable')
        return [ev(7, A, 5000)]
      },
    })
    await sync(provider(6000), f)
    expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(6000)
    expect(owners.get(7)?.owner).to.equal(A)
  })

  it('does not skip a range on an error that only carries the number 4444', async () => {
    chainData.set('l2_owner_set_last_synced_block', { value: { block: 0 } })
    const f = () => ({
      filters: { OwnerSet: () => 'f' },
      queryFilter: async () => { throw new Error('upstream said 4444 for no stated reason') },
    })
    let err: any
    try { await sync(provider(6000), f) } catch (e) { err = e }
    expect(err?.message).to.match(/4444/)
    expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(0)
  })

  it('does nothing without an L2 provider', async () => {
    await sync(null, factory([]))
    expect(ranges).to.have.length(0)
  })

  // ChainSyncService beats a loop's heartbeat only when its task resolves, and its
  // watchdog restarts the whole service when a declared loop has gone quiet for its
  // timeout. A task that rejects takes the session/auth loop and the others down
  // with it, every 4 minutes while the trouble lasts.
  describe('runOwnerSetSync (what ChainSyncService registers)', () => {
    const quiet = async (fn: () => Promise<void>) => {
      const real = console.error
      const lines: string[] = []
      console.error = (...a: any[]) => { lines.push(a.map(String).join(' ')) }
      try { await fn() } finally { console.error = real }
      return lines
    }

    it('resolves, logs and reports the error when a range fails, and keeps the cursor', async () => {
      chainData.set('l2_owner_set_last_synced_block', { value: { block: 1000 } })
      const seen: unknown[] = []
      const lines = await quiet(() => run(provider(5500), e => seen.push(e), factory([ev(7, A, 1500)], 4000)))
      expect(seen).to.have.length(1)
      expect((seen[0] as Error).message).to.equal('rpc down')
      expect(lines.join('\n')).to.contain('rpc down')
      expect(chainData.get('l2_owner_set_last_synced_block').value.block).to.equal(3000)
    })

    it('resolves when the provider cannot give the head', async () => {
      const seen: unknown[] = []
      await quiet(() => run({ getBlockNumber: async () => { throw new Error('circuit breaker is open') } }, e => seen.push(e), factory([])))
      expect((seen[0] as Error).message).to.equal('circuit breaker is open')
    })

    it('resolves when the database fails (the migration has not been applied)', async () => {
      failDb = true
      const seen: unknown[] = []
      await quiet(() => run(provider(5500), e => seen.push(e), factory([])))
      expect((seen[0] as Error).message).to.contain('TokenOwnerSince')
    })

    it('does not report anything on a clean run, and works without a callback', async () => {
      chainData.set('l2_owner_set_last_synced_block', { value: { block: 1000 } })
      const seen: unknown[] = []
      await run(provider(1500), e => seen.push(e), factory([ev(7, A, 1200)]))
      expect(seen).to.have.length(0)
      expect(owners.get(7)?.owner).to.equal(A)
      await quiet(() => run(provider(5500), undefined, factory([], 4000)))
    })
  })
})
