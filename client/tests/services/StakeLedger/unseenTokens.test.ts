// Tests for how StakeLedger treats tokens it has not seen yet (review of #97):
// no RPC read inside the ledger transaction, and deposit / withdraw replays that
// never reconstruct a balance from the chain's HEAD.
//
// The module reads the network id from the environment at import time, so set it
// first and import the module lazily (a static import would be hoisted above this).
process.env.NETWORK_ID = process.env.NETWORK_ID || '1'
process.env.CLIENT_ID = process.env.CLIENT_ID || '1'

import { expect } from 'chai'
import type * as StakeLedgerModule from '../../../src/services/StakeLedger/index'
import type { RuntimeState } from '../../../src/services/StakeLedger/index'
import { PRECISION, balanceOf } from '../../../src/services/StakeLedger/contractMath'

let L: typeof StakeLedgerModule

before(async () => {
  L = await import('../../../src/services/StakeLedger/index')
})

const W = (n: number | bigint): bigint => BigInt(n) * PRECISION // whole CAW -> wei
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const byNumber = (a: number, b: number) => a - b // a plain sort compares as strings ([31, 9])

function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    multiplier: PRECISION,
    totalCaw: W(1_000_000),
    ownership: new Map(),
    lastBlock: 100n,
    lastLogIndex: 0,
    halted: false,
    ...overrides,
  }
}

/** Mock chain: records every cawOwnership(tokenId) read. */
function useChain(read: (tokenId: number) => Promise<bigint>): number[] {
  const reads: number[] = []
  L._setContractForTests({
    rewardMultiplier: async () => PRECISION,
    cawOwnership: async (tokenId: number) => {
      reads.push(Number(tokenId))
      return read(Number(tokenId))
    },
  })
  return reads
}

/** Mock Prisma transaction that records what the ledger writes. */
function makeTx() {
  const snapshots: any[] = []
  const tx: any = {
    rewardMultiplierSnapshot: { createMany: async () => ({ count: 0 }) },
    cawOwnershipSnapshot: {
      createMany: async ({ data }: any) => {
        snapshots.push(...data)
        return { count: data.length }
      },
      findFirst: async () => null,
      create: async ({ data }: any) => {
        snapshots.push(data)
        return data
      },
    },
    cawOwnershipCurrent: { upsert: async (a: any) => a },
    user: { updateMany: async () => ({ count: 0 }) },
    stakeLedgerState: { upsert: async (a: any) => a },
  }
  return { tx, snapshots }
}

const likeAction = (senderId: number, receiverId: number) => ({
  actionType: 1, // LIKE: sender pays 2000 CAW, 400 go to the multiplier, 1600 to the receiver
  senderId,
  receiverId,
  cawonce: 1,
  text: '',
})

const withdrawAction = (senderId: number, wholeCaw: string) => ({
  actionType: 6, // WITHDRAW; amounts = [withdrawn amount, validator tip]
  senderId,
  cawonce: 1,
  text: '',
  amounts: [wholeCaw, '0'],
})

const recordParams = (rawAction: any, validatorId = 9) => ({
  rawAction,
  validatorId,
  blockNumber: 101n,
  blockTimestamp: new Date(0),
  txHash: '0xabc',
  logIndex: 0,
  actionIndex: 0,
})

describe('StakeLedger / unseen tokens (behaviour)', () => {
  beforeEach(() => L._resetForTests())
  afterEach(() => L._resetForTests())

  it('completes even when the chain never answers (no RPC inside the ledger transaction)', async function () {
    this.timeout(5000)
    L._injectStateForTests(makeState())
    useChain(() => new Promise<bigint>(() => {})) // never resolves
    const { tx } = makeTx()
    const outcome = await Promise.race([
      L.recordAction(tx, recordParams(likeAction(5, 6))).then(() => 'done'),
      sleep(1000).then(() => 'hung'),
    ])
    expect(outcome).to.equal('done')
  })

  it('does not read the chain for an unseen sender, and does not halt the ledger', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx()
    await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(reads).to.deep.equal([])
    expect(L._peekState()!.halted).to.equal(false)
  })

  it('does not over-count when an older deposit is replayed after a newer one is already on chain', async () => {
    // Chain history for token 29: deposit A = 100, then deposit B = 50 (HEAD = 150).
    L._injectStateForTests(makeState({ totalCaw: 0n }))
    const reads = useChain(async () => W(150))
    const { tx } = makeTx()
    const deposits = [
      { amountWei: W(100), txHash: '0xa', logIndex: 1 },
      { amountWei: W(50), txHash: '0xb', logIndex: 2 },
    ]
    for (const d of deposits) {
      const r = await L.recordDeposit(tx, { tokenId: 29, blockNumber: 10n, blockTimestamp: new Date(0), ...d })
      expect(r).to.not.equal(null)
      await L.applyDepositToMemory(r!.tokenId, r!.amountWei, r!.afterOwnership)
    }
    const s = L._peekState()!
    expect(balanceOf(s.ownership.get(29)!, s.multiplier)).to.equal(W(150))
    expect(s.totalCaw).to.equal(W(150))
    expect(reads).to.deep.equal([])
  })

  it('replays a WITHDRAW of an unseen sender without a chain read and with an exact totalCaw', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(20)) // HEAD already reflects the withdraw
    const { tx, snapshots } = makeTx()
    const postCommit = await L.recordAction(tx, recordParams(withdrawAction(29, '50')))
    expect(postCommit).to.not.equal(null) // not skipped as "insufficient"
    postCommit!()
    expect(reads).to.deep.equal([])
    expect(L._peekState()!.totalCaw).to.equal(W(1_000_000) - W(50))
    const row = snapshots.find((r) => r.tokenId === 29)
    expect(row.delta).to.equal((-W(50)).toString())
    expect(row.balance).to.equal('0')
  })

  it('still processes actions of tokens already in the cache (regression guard)', async () => {
    L._injectStateForTests(makeState({ ownership: new Map([[5, W(10_000)], [6, 0n]]) }))
    const reads = useChain(async () => 0n)
    const { tx, snapshots } = makeTx()
    const postCommit = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(postCommit).to.not.equal(null)
    postCommit!()
    expect(reads).to.deep.equal([])
    expect(snapshots.find((r) => r.tokenId === 5).balance).to.equal(W(8_000).toString())
    expect(snapshots.find((r) => r.tokenId === 6).balance).to.equal(W(1_600).toString())
    expect(L._peekState()!.lastBlock).to.equal(101n)
    expect(L._peekState()!.halted).to.equal(false)
  })
})

describe('StakeLedger / ownership prefetch (new API)', () => {
  beforeEach(() => L._resetForTests())
  afterEach(() => L._resetForTests())

  it('tokensTouchedByAction leaves out a WITHDRAW sender and the first recipient', () => {
    expect(L.tokensTouchedByAction(likeAction(5, 6), 9).sort(byNumber)).to.deep.equal([5, 6, 9])
    const w = { ...withdrawAction(29, '50'), recipients: [29, 31] }
    expect(L.tokensTouchedByAction(w, 9).sort(byNumber)).to.deep.equal([9, 31])
  })

  it('prefetch reads each unseen token once, then recordAction reads nothing', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async (id) => (id === 5 ? W(10_000) : 0n))
    await L.prefetchOwnershipForAction({ rawAction: likeAction(5, 6) as any, validatorId: 9, blockNumber: 101n, logIndex: 0 })
    expect(reads.slice().sort(byNumber)).to.deep.equal([5, 6, 9])
    const { tx, snapshots } = makeTx()
    const postCommit = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(postCommit).to.not.equal(null)
    expect(reads.length).to.equal(3)
    expect(snapshots.find((r) => r.tokenId === 5).balance).to.equal(W(8_000).toString())
  })

  it('an unseen sender that comes up short is skipped, queued, and refreshed after the transaction', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx()
    expect(await L.recordAction(tx, recordParams(likeAction(5, 6)))).to.equal(null)
    expect(reads).to.deep.equal([])
    expect(L._peekState()!.halted).to.equal(false)
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([5])
    await L.flushOwnershipRefreshes()
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    expect(L._peekState()!.ownership.get(5)).to.equal(W(10_000))
    expect(await L.recordAction(tx, recordParams(likeAction(5, 6)))).to.not.equal(null)
  })

  it('an unseen WITHDRAW sender is queued for a refresh after the transaction', async () => {
    L._injectStateForTests(makeState())
    useChain(async () => W(20))
    const { tx } = makeTx()
    await L.recordAction(tx, recordParams(withdrawAction(29, '50')))
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([29])
    await L.flushOwnershipRefreshes()
    expect(L._peekState()!.ownership.get(29)).to.equal(W(20))
  })

  it('a chain read that never answers is abandoned at the timeout and caches nothing', async function () {
    this.timeout(5000)
    L._injectStateForTests(makeState())
    L._setOwnershipFetchTimeoutForTests(40)
    useChain(() => new Promise<bigint>(() => {}))
    const t0 = Date.now()
    await L.prefetchOwnershipForAction({ rawAction: likeAction(5, 6) as any, validatorId: 0, blockNumber: 101n, logIndex: 0 })
    expect(Date.now() - t0).to.be.lessThan(1000)
    expect(L._peekState()!.ownership.has(5)).to.equal(false)
  })

  it('a chain read never overwrites a value cached while the read was in flight', async () => {
    L._injectStateForTests(makeState())
    useChain(async () => {
      await sleep(30)
      return 999n
    })
    const pending = L.prefetchOwnershipForAction({ rawAction: likeAction(5, 0) as any, validatorId: 0, blockNumber: 101n, logIndex: 0 })
    await sleep(5)
    L._peekState()!.ownership.set(5, 7n)
    await pending
    expect(L._peekState()!.ownership.get(5)).to.equal(7n)
  })
})
