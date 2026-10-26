// Tests for how StakeLedger treats tokens it has not seen yet (review of #97):
// no RPC read inside the ledger transaction, and deposit / withdraw replays that
// never reconstruct a balance from the chain's HEAD.
//
// The module reads the network id from the environment at import time, so it is
// imported lazily (a static import would be hoisted above any assignment made
// here) from each describe's before() hook. A root-level hook would run for every
// test file in the mocha run, not just this one.

import { expect } from 'chai'
import type * as StakeLedgerModule from '../../../src/services/StakeLedger/index'
import type { RuntimeState } from '../../../src/services/StakeLedger/index'
import { PRECISION, balanceOf } from '../../../src/services/StakeLedger/contractMath'

let L: typeof StakeLedgerModule

async function loadModule(): Promise<void> {
  process.env.NETWORK_ID = process.env.NETWORK_ID || '1'
  process.env.CLIENT_ID = process.env.CLIENT_ID || '1'
  L = await import('../../../src/services/StakeLedger/index')
}

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

/**
 * Mock Prisma transaction that records what the ledger writes.
 * hasEarlierAction controls what $queryRaw (hasEarlierActionInSameBlock's
 * probe) reports: false (default) means "no earlier action in this block",
 * matching every existing test's scenario, so this default changes nothing
 * for them.
 */
function makeTx(hasEarlierAction = false) {
  const snapshots: any[] = []
  const tx: any = {
    $queryRaw: async () => (hasEarlierAction ? [{ '?column?': 1 }] : []),
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

const withdrawAction = (senderId: number, wholeCaw: string, tip = '0') => ({
  actionType: 6, // WITHDRAW; amounts = [withdrawn amount, validator tip]
  senderId,
  cawonce: 1,
  text: '',
  amounts: [wholeCaw, tip],
})

const recordParams = (rawAction: any, validatorId = 9) => ({
  rawAction,
  validatorId,
  chainId: 1,
  blockNumber: 101n,
  blockTimestamp: new Date(0),
  txHash: '0xabc',
  logIndex: 0,
  actionIndex: 0,
})

describe('StakeLedger / unseen tokens (behaviour)', () => {
  before(loadModule)
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
  before(loadModule)
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

  it('an unseen sender that comes up short is skipped; the returned callback queues the refresh after the commit', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx()
    const afterCommit = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(afterCommit).to.be.a('function') // skipped, but the callback that queues the refresh is returned
    expect(reads).to.deep.equal([])
    expect(L._peekState()!.halted).to.equal(false)
    expect(L._peekState()!.lastBlock).to.equal(100n) // nothing was applied
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([]) // nothing is queued from inside the transaction
    afterCommit!()
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([5])
    await L.flushOwnershipRefreshes()
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    expect(L._peekState()!.ownership.get(5)).to.equal(W(10_000))
    const applied = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    applied!()
    expect(L._peekState()!.lastBlock).to.equal(101n) // with the refreshed balance the action is applied
  })

  it('an unseen WITHDRAW sender is queued for a refresh after the transaction', async () => {
    L._injectStateForTests(makeState())
    useChain(async () => W(20))
    const { tx } = makeTx()
    const afterCommit = await L.recordAction(tx, recordParams(withdrawAction(29, '50')))
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([]) // not from inside the transaction
    afterCommit!()
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

describe('StakeLedger / review follow-ups (post-commit queue, block-pinned refresh, WITHDRAW with a tip)', () => {
  before(loadModule)
  beforeEach(() => L._resetForTests())
  afterEach(() => L._resetForTests())

  /** Mock chain that also records the overrides (block tag) of every cawOwnership read. */
  function recordChain(read: (tokenId: number) => Promise<bigint>): Array<{ tokenId: number; overrides: any }> {
    const calls: Array<{ tokenId: number; overrides: any }> = []
    L._setContractForTests({
      rewardMultiplier: async () => PRECISION,
      cawOwnership: async (tokenId: number, overrides?: any) => {
        calls.push({ tokenId: Number(tokenId), overrides })
        return read(Number(tokenId))
      },
    })
    return calls
  }

  it('an unseen WITHDRAW sender whose action carries a validator tip is applied, not skipped', async () => {
    // Real WITHDRAW actions carry a validator tip (amounts = [amount, tip]) and step 2 charges it to the sender.
    L._injectStateForTests(makeState())
    const reads = useChain(async () => 0n)
    const { tx, snapshots } = makeTx()
    const afterCommit = await L.recordAction(tx, recordParams({ ...withdrawAction(29, '50', '1000'), recipients: [29] }))
    afterCommit!()
    const s = L._peekState()!
    expect(s.lastBlock).to.equal(101n) // applied, not skipped as insufficient
    expect(s.totalCaw).to.equal(W(1_000_000) - W(50)) // only the withdrawn amount leaves the pool; the tip moves between holders
    expect(reads).to.deep.equal([])
    const sender = snapshots.filter((r) => r.tokenId === 29)
    expect(sender.map((r) => r.delta)).to.deep.equal([(-W(50)).toString(), (-W(1000)).toString()])
    expect(sender[sender.length - 1].balance).to.equal('0')
    expect(snapshots.find((r) => r.tokenId === 9).delta).to.equal(W(1000).toString()) // the validator (id 9) got the tip
  })

  it('the assumed pre-withdraw balance covers everything step 2 charges: extra recipients and the tip', async () => {
    L._injectStateForTests(makeState())
    useChain(async () => 0n)
    const { tx, snapshots } = makeTx()
    const action = { ...withdrawAction(29, '50', '1000'), recipients: [29, 31], amounts: ['50', '20', '1000'] }
    const afterCommit = await L.recordAction(tx, recordParams(action))
    afterCommit!()
    expect(L._peekState()!.lastBlock).to.equal(101n)
    const sender = snapshots.filter((r) => r.tokenId === 29)
    expect(sender[sender.length - 1].balance).to.equal('0')
    expect(snapshots.find((r) => r.tokenId === 31).delta).to.equal(W(20).toString())
  })

  it('a rolled-back or retried transaction leaves nothing in the refresh queue', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    // (a) an action skipped for insufficient balance: the transaction rolls back, so the caller never runs the callback
    const skipped = await L.recordAction(makeTx().tx, recordParams(likeAction(5, 6)))
    expect(skipped).to.be.a('function')
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    // (b) an unseen WITHDRAW sender whose ledger write fails inside the transaction
    const failing = makeTx()
    failing.tx.stakeLedgerState.upsert = async () => {
      throw new Error('commit failed')
    }
    let threw = false
    try {
      await L.recordAction(failing.tx, recordParams(withdrawAction(29, '50')))
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    // the next flush has nothing to read for the tokens of the rolled-back actions
    await L.flushOwnershipRefreshes()
    expect(reads).to.deep.equal([])
  })

  it('the refresh reads the state just before a skipped action, not HEAD', async () => {
    L._injectStateForTests(makeState())
    const calls = recordChain(async () => W(10_000))
    const afterCommit = await L.recordAction(makeTx().tx, recordParams(likeAction(5, 6))) // block 101
    afterCommit!()
    await L.flushOwnershipRefreshes()
    expect(calls).to.deep.equal([{ tokenId: 5, overrides: { blockTag: 100 } }])
    expect(L._peekState()!.ownership.get(5)).to.equal(W(10_000))
  })

  it("the refresh of an unseen WITHDRAW sender reads the state at the action's block", async () => {
    L._injectStateForTests(makeState())
    const calls = recordChain(async () => W(20))
    const afterCommit = await L.recordAction(makeTx().tx, recordParams(withdrawAction(29, '50'))) // block 101
    afterCommit!()
    await L.flushOwnershipRefreshes()
    expect(calls).to.deep.equal([{ tokenId: 29, overrides: { blockTag: 101 } }])
    expect(L._peekState()!.ownership.get(29)).to.equal(W(20))
  })

  it('the refresh never overwrites a value that changed while the read was in flight', async () => {
    L._injectStateForTests(makeState({ ownership: new Map([[5, W(10)]]) })) // stale: too little for a LIKE
    useChain(async () => {
      await sleep(30)
      return W(10_000)
    })
    const afterCommit = await L.recordAction(makeTx().tx, recordParams(likeAction(5, 6)))
    afterCommit!()
    const flushing = L.flushOwnershipRefreshes()
    await sleep(5)
    L._peekState()!.ownership.set(5, 7n)
    await flushing
    expect(L._peekState()!.ownership.get(5)).to.equal(7n)
  })

  it('an RPC that cannot serve the block fails the read: nothing is written, and it warns once', async () => {
    L._injectStateForTests(makeState())
    L._setContractForTests({
      rewardMultiplier: async () => PRECISION,
      cawOwnership: async () => {
        throw new Error('missing trie node 0xabc (path ) state 0xdef is not available')
      },
    })
    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: any[]) => {
      warns.push(String(args[0]))
    }
    try {
      for (let i = 0; i < 3; i++) {
        const afterCommit = await L.recordAction(makeTx().tx, recordParams(likeAction(5, 6)))
        afterCommit!()
        await L.flushOwnershipRefreshes()
      }
    } finally {
      console.warn = originalWarn
    }
    expect(L._peekState()!.ownership.has(5)).to.equal(false)
    expect(warns.filter((w) => w.includes('non-archive')).length).to.equal(1)
  })

  it('prefetch and recordAction agree on which actions are already processed', async () => {
    L._injectStateForTests(makeState({ lastBlock: 101n, lastLogIndex: 3 }))
    const reads = useChain(async () => W(1))
    for (const [blockNumber, logIndex] of [[100n, 9], [101n, 3], [101n, 0]] as Array<[bigint, number]>) {
      await L.prefetchOwnershipForAction({ rawAction: likeAction(5, 6) as any, validatorId: 9, blockNumber, logIndex })
      const afterCommit = await L.recordAction(makeTx().tx, { ...recordParams(likeAction(5, 6)), blockNumber, logIndex })
      expect(afterCommit, `${blockNumber}/${logIndex}`).to.equal(null)
    }
    expect(reads).to.deep.equal([])
    // one position later both go ahead: prefetch reads the unseen tokens
    await L.prefetchOwnershipForAction({ rawAction: likeAction(5, 6) as any, validatorId: 9, blockNumber: 101n, logIndex: 4 })
    expect(reads.length).to.be.greaterThan(0)
  })

  // nyaromesama's 2026-09-21 09:08Z review, point 5: cawOwnership(id, { blockTag })
  // gives the ledger's state after the WHOLE block, not after one action. When the
  // same sender has another action earlier in the same block, a refresh queued at
  // blockNumber - 1n (the skip-path's "just before this action") is stale -- it
  // predates that earlier action too. On this node's own data, 78% of the
  // multi-action (block, sender) groups are exactly this shape (a same-block,
  // different-tx earlier action), so it's the common case, not an edge case.
  it('does not queue a chain refresh when the sender has an earlier action already committed in this block', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx(true) // true: this sender has an earlier Action row in this block
    const afterCommit = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(afterCommit).to.be.a('function') // still skipped as insufficient
    afterCommit!()
    // No refresh queued: a block - 1 read would predate the sender's earlier
    // action in this block, not just this one, so it would be stale either way.
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    await L.flushOwnershipRefreshes()
    expect(reads).to.deep.equal([]) // never read from chain
    expect(L._peekState()!.ownership.has(5)).to.equal(false) // cache left untouched
  })

  it('still queues the chain refresh when the sender has no earlier action in this block (regression guard)', async () => {
    L._injectStateForTests(makeState())
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx(false) // explicit: no earlier action, same as every other test in this file
    const afterCommit = await L.recordAction(tx, recordParams(likeAction(5, 6)))
    expect(afterCommit).to.be.a('function')
    afterCommit!()
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([5])
    await L.flushOwnershipRefreshes()
    expect(L._peekState()!.ownership.get(5)).to.equal(W(10_000))
  })

  it('does not queue a chain refresh for the step-2 (tip) insufficient-balance skip either, under the same condition', async () => {
    // OTHER:tip, not WITHDRAW -- a WITHDRAW sender always takes the "unseen"
    // branch in step 1 (see the WITHDRAW branch above), so it never reaches
    // this test's scenario: a SEEN sender whose cached balance covers step 1
    // but comes up short only once step 2's tip is added.
    L._injectStateForTests(makeState({ ownership: new Map([[29, W(50)]]) })) // enough for the tip target, short for sender's own tip charge
    const reads = useChain(async () => W(10_000))
    const { tx } = makeTx(true)
    const tipAction = {
      actionType: 7, // OTHER
      senderId: 29,
      cawonce: 1,
      text: 'tip:1',
      recipients: [31],
      amounts: ['50', '1000'], // recipient gets 50, validator tip 1000 -- sender can't cover both from W(50)
    }
    const afterCommit = await L.recordAction(tx, recordParams(tipAction))
    expect(afterCommit).to.be.a('function') // skipped as insufficient at step 2
    afterCommit!()
    expect(L._pendingOwnershipRefreshForTests()).to.deep.equal([])
    await L.flushOwnershipRefreshes()
    expect(reads).to.deep.equal([])
    expect(L._peekState()!.ownership.get(29)).to.equal(W(50)) // cache left untouched
  })
})
