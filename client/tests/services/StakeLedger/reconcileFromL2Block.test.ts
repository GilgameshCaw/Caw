import { expect } from 'chai'

process.env.CLIENT_ID = '1'

import {
  reconcileFromL2Block,
  _injectStateForTests,
  _peekState,
  _resetForTests,
  _setContractForTests,
  _setReconcilePrismaForTests,
  type RuntimeState,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    multiplier: PRECISION,
    totalCaw: 999n,
    capRatio: 123n,
    capLastUpdatedAt: 456n,
    ownership: new Map([[1, 111n], [2, 222n]]),
    lastBlock: 90n,
    lastLogIndex: 7,
    halted: true,
    ...overrides,
  }
}

function makePrisma(userRows = [{ tokenId: 1 }, { tokenId: 2 }]) {
  let transactionCalls = 0
  let stateUpsert: any = null
  let repairGuardUpsert: any = null
  let deletedCurrent = false
  let createdCurrent: any[] = []
  const userUpdates: any[] = []

  const tx = {
    stakeLedgerState: {
      upsert: async (args: any) => {
        stateUpsert = args
        return {}
      },
    },
    stakeLedgerRepairGuard: {
      upsert: async (args: any) => {
        repairGuardUpsert = args
        return {}
      },
    },
    $queryRawUnsafe: async () => [],
    cawOwnershipCurrent: {
      deleteMany: async () => {
        deletedCurrent = true
        return { count: 2 }
      },
      createMany: async (args: any) => {
        createdCurrent = args.data
        return { count: args.data.length }
      },
    },
    user: {
      updateMany: async (args: any) => {
        userUpdates.push(args)
        return { count: 1 }
      },
    },
  }

  const mock = {
    user: {
      findMany: async () => userRows,
    },
    cawOwnershipCurrent: {
      findMany: async () => [{ tokenId: 1 }, { tokenId: 2 }],
    },
    $transaction: async (fn: any) => {
      transactionCalls++
      return await fn(tx)
    },
  }

  return {
    mock,
    inspect: () => ({
      transactionCalls,
      stateUpsert,
      repairGuardUpsert,
      deletedCurrent,
      createdCurrent,
      userUpdates,
    }),
  }
}

describe('StakeLedger / reconcileFromL2Block', () => {
  beforeEach(() => {
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
  })

  it('reads one fixed L2 block, commits authoritative state atomically, then replaces runtime state', async () => {
    const oldState = makeState()
    _injectStateForTests(oldState)

    const blockTags: number[] = []
    _setContractForTests({
      rewardMultiplier: async (opts: any) => {
        blockTags.push(opts.blockTag)
        return PRECISION + 10n
      },
      totalCaw: async (opts: any) => {
        blockTags.push(opts.blockTag)
        return 5000n
      },
      cawOwnership: async (tokenId: number, opts: any) => {
        blockTags.push(opts.blockTag)
        if (tokenId === 1) return 1000n
        if (tokenId === 2) return 2000n
        throw new Error(`unexpected token ${tokenId}`)
      },
    })

    const db = makePrisma()
    _setReconcilePrismaForTests(db.mock)

    await reconcileFromL2Block(100n)

    expect(blockTags).to.deep.equal([100, 100, 100, 100])

    const written = db.inspect()
    expect(written.transactionCalls).to.equal(1)
    expect(written.deletedCurrent).to.equal(true)
    expect(written.createdCurrent).to.deep.equal([
      { tokenId: 1, ownership: '1000' },
      { tokenId: 2, ownership: '2000' },
    ])

    expect(written.stateUpsert.update.multiplier).to.equal((PRECISION + 10n).toString())
    expect(written.stateUpsert.update.totalCaw).to.equal('5000')
    expect(written.stateUpsert.update.lastBlock).to.equal(100n)
    expect(written.stateUpsert.update.lastLogIndex).to.equal(2147483647)
    expect(written.repairGuardUpsert).to.deep.equal({
      where: { networkId: 1 },
      create: {
        networkId: 1,
        repairRequired: false,
      },
      update: {
        repairRequired: false,
      },
    })

    expect(written.userUpdates).to.have.length(2)

    const next = _peekState()!
    expect(next).to.not.equal(oldState)
    expect(next.multiplier).to.equal(PRECISION + 10n)
    expect(next.totalCaw).to.equal(5000n)
    expect(next.ownership.get(1)).to.equal(1000n)
    expect(next.ownership.get(2)).to.equal(2000n)
    expect(next.lastBlock).to.equal(100n)
    expect(next.lastLogIndex).to.equal(2147483647)
    expect(next.halted).to.equal(false)

    // Dynamic-cost cap belongs to its independent refresh path and survives recovery.
    expect(next.capRatio).to.equal(123n)
    expect(next.capLastUpdatedAt).to.equal(456n)
  })

  it('recovers authoritative ownership even when matching User rows are missing', async () => {
    _injectStateForTests(makeState())

    _setContractForTests({
      rewardMultiplier: async () => PRECISION + 10n,
      totalCaw: async () => 5000n,
      cawOwnership: async (tokenId: number) => {
        if (tokenId === 1) return 1000n
        if (tokenId === 2) return 2000n
        throw new Error(`unexpected token ${tokenId}`)
      },
    })

    const db = makePrisma([])
    _setReconcilePrismaForTests(db.mock)

    await reconcileFromL2Block(100n)

    const written = db.inspect()
    expect(written.transactionCalls).to.equal(1)
    expect(written.createdCurrent).to.deep.equal([
      { tokenId: 1, ownership: '1000' },
      { tokenId: 2, ownership: '2000' },
    ])
    expect(written.userUpdates).to.have.length(2)
    expect(written.repairGuardUpsert.update.repairRequired).to.equal(false)

    const next = _peekState()!
    expect(next.ownership.get(1)).to.equal(1000n)
    expect(next.ownership.get(2)).to.equal(2000n)
    expect(next.halted).to.equal(false)
  })

  it('leaves runtime state untouched when the database transaction fails after fixed-block reads succeed', async () => {
    const oldState = makeState()
    _injectStateForTests(oldState)

    const blockTags: number[] = []
    _setContractForTests({
      rewardMultiplier: async (opts: any) => {
        blockTags.push(opts.blockTag)
        return PRECISION + 10n
      },
      totalCaw: async (opts: any) => {
        blockTags.push(opts.blockTag)
        return 5000n
      },
      cawOwnership: async (tokenId: number, opts: any) => {
        blockTags.push(opts.blockTag)
        if (tokenId === 1) return 1000n
        if (tokenId === 2) return 2000n
        throw new Error(`unexpected token ${tokenId}`)
      },
    })

    let transactionCalls = 0
    const mock = {
      user: {
        findMany: async () => [{ tokenId: 1 }, { tokenId: 2 }],
      },
      cawOwnershipCurrent: {
        findMany: async () => [{ tokenId: 1 }, { tokenId: 2 }],
      },
      $transaction: async () => {
        transactionCalls++
        throw new Error('database commit failed')
      },
    }
    _setReconcilePrismaForTests(mock)

    let thrown: any = null
    try {
      await reconcileFromL2Block(100n)
    } catch (err) {
      thrown = err
    }

    expect(blockTags).to.deep.equal([100, 100, 100, 100])
    expect(transactionCalls).to.equal(1)
    expect(thrown).to.be.instanceOf(Error)
    expect(thrown.message).to.include('database commit failed')

    // DB did not commit, so the post-commit runtime replacement must not occur.
    expect(_peekState()).to.equal(oldState)
    expect(_peekState()!.multiplier).to.equal(PRECISION)
    expect(_peekState()!.totalCaw).to.equal(999n)
    expect(_peekState()!.ownership.get(1)).to.equal(111n)
    expect(_peekState()!.ownership.get(2)).to.equal(222n)
    expect(_peekState()!.lastBlock).to.equal(90n)
    expect(_peekState()!.lastLogIndex).to.equal(7)
    expect(_peekState()!.halted).to.equal(true)
  })

  it('aborts before transaction and leaves runtime state untouched when any fixed-block ownership read fails', async () => {
    const oldState = makeState()
    _injectStateForTests(oldState)

    _setContractForTests({
      rewardMultiplier: async () => PRECISION + 10n,
      totalCaw: async () => 5000n,
      cawOwnership: async (tokenId: number) => {
        if (tokenId === 2) throw new Error('archive RPC failed')
        return 1000n
      },
    })

    const db = makePrisma()
    _setReconcilePrismaForTests(db.mock)

    let thrown: any = null
    try {
      await reconcileFromL2Block(100n)
    } catch (err) {
      thrown = err
    }

    expect(thrown).to.be.instanceOf(Error)
    expect(thrown.message).to.include('archive RPC failed')

    const written = db.inspect()
    expect(written.transactionCalls).to.equal(0)
    expect(written.stateUpsert).to.equal(null)
    expect(written.deletedCurrent).to.equal(false)
    expect(written.createdCurrent).to.deep.equal([])
    expect(written.userUpdates).to.deep.equal([])

    // No post-commit replacement occurred.
    expect(_peekState()).to.equal(oldState)
    expect(_peekState()!.lastBlock).to.equal(90n)
    expect(_peekState()!.lastLogIndex).to.equal(7)
    expect(_peekState()!.halted).to.equal(true)
  })
})
