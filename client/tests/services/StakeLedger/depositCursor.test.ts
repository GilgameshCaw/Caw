// recordDeposit must not move the action cursor (lastBlock/lastLogIndex).
//
// The cursor is in L2 (block, logIndex) space: recordAction skips anything at
// or below it. Deposits come from the L1 Deposited event, so their block
// number is an L1 block. Writing it into the cursor leaves an L1 number there
// until the next action; a restart in between loads it into memory.

import { expect } from 'chai'

process.env.CLIENT_ID = '1'

import {
  recordAction,
  recordDeposit,
  _peekState,
  _resetForTests,
  _injectStateForTests,
  type RuntimeState,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

const L2_BLOCK = 47_598_000n
const L1_BLOCK = 11_830_120n

type Row = { totalCaw: string; multiplier: string; lastBlock: bigint; lastLogIndex: number }

// Stand-in for the Prisma tx: keeps the StakeLedgerState row and counts
// CawOwnershipSnapshot writes.
function fakeTx(db: { row: Row | null; snapshots: number }) {
  return {
    cawOwnershipSnapshot: {
      findFirst: async () => null,
      create: async () => { db.snapshots++ },
      createMany: async (args: any) => { db.snapshots += args.data.length },
    },
    rewardMultiplierSnapshot: { createMany: async () => {} },
    cawOwnershipCurrent: { upsert: async () => {} },
    user: { updateMany: async () => {} },
    stakeLedgerState: {
      upsert: async (args: any) => {
        db.row = db.row ? { ...db.row, ...args.update } : { ...args.create }
      },
    },
  } as any
}

// What ensureBooted() builds from the persisted row after a restart.
function bootFrom(row: Row, ownership: Map<number, bigint>): RuntimeState {
  return {
    multiplier: BigInt(row.multiplier),
    totalCaw: BigInt(row.totalCaw),
    capRatio: 0n,
    capLastUpdatedAt: 0n,
    ownership: new Map(ownership),
    lastBlock: BigInt(row.lastBlock),
    lastLogIndex: row.lastLogIndex,
    halted: false,
  }
}

// An UNFOLLOW that pays the validator 1 CAW. UNFOLLOW has no domain object,
// so a re-delivered one always reaches recordAction; only the cursor stops it.
const unfollow = {
  actionType: 5,
  senderId: 7,
  receiverId: 9,
  cawonce: 3,
  recipients: [],
  amounts: [1],
} as any

describe('StakeLedger / recordDeposit and the action cursor', () => {
  beforeEach(() => _resetForTests())
  afterEach(() => _resetForTests())

  it('leaves lastBlock/lastLogIndex at the last action, in memory and in the row', async () => {
    const ownership = new Map<number, bigint>([[7, 100n * PRECISION]])
    const db = {
      row: { totalCaw: (100n * PRECISION).toString(), multiplier: PRECISION.toString(), lastBlock: L2_BLOCK, lastLogIndex: 11 } as Row,
      snapshots: 0,
    }
    _injectStateForTests(bootFrom(db.row, ownership))

    const res = await recordDeposit(fakeTx(db), {
      tokenId: 7,
      amountWei: 5n * PRECISION,
      blockNumber: L1_BLOCK,
      blockTimestamp: new Date(),
      txHash: '0xdep',
      logIndex: 21,
    })

    expect(res).to.not.equal(null)
    expect(db.snapshots).to.equal(1)
    expect(db.row.totalCaw).to.equal((105n * PRECISION).toString())
    expect(db.row.lastBlock).to.equal(L2_BLOCK)
    expect(db.row.lastLogIndex).to.equal(11)
    expect(_peekState()!.lastBlock).to.equal(L2_BLOCK)
  })

  it('still skips an already-recorded action after a restart that follows a deposit', async () => {
    const ownership = new Map<number, bigint>([[7, 100n * PRECISION]])
    const db = { row: null as Row | null, snapshots: 0 }
    _injectStateForTests({
      multiplier: PRECISION,
      totalCaw: 100n * PRECISION,
      capRatio: 0n,
      capLastUpdatedAt: 0n,
      ownership,
      lastBlock: 0n,
      lastLogIndex: -1,
      halted: false,
    })

    // The UNFOLLOW lands and is recorded.
    const params = {
      rawAction: unfollow,
      validatorId: 1,
      blockNumber: L2_BLOCK,
      blockTimestamp: new Date(),
      txHash: '0xact',
      logIndex: 11,
      actionIndex: 0,
    }
    const commit = await recordAction(fakeTx(db), params)
    expect(commit).to.be.a('function')
    commit!()
    const afterFirst = db.snapshots

    // A deposit is seen on L1 before the next action.
    const dep = await recordDeposit(fakeTx(db), {
      tokenId: 7,
      amountWei: 5n * PRECISION,
      blockNumber: L1_BLOCK,
      blockTimestamp: new Date(),
      txHash: '0xdep',
      logIndex: 21,
    })
    expect(dep).to.not.equal(null)

    // Restart: memory is rebuilt from the persisted row.
    _resetForTests()
    _injectStateForTests(bootFrom(db.row!, ownership))

    // The same UNFOLLOW is delivered again (retry, rescan, duplicate RawEvent).
    const again = await recordAction(fakeTx(db), params)
    expect(again).to.equal(null)
    expect(db.snapshots).to.equal(afterFirst + 1) // only the deposit row
  })

  it('creates the row with the empty cursor when the first ledger write is a deposit', async () => {
    const db = { row: null as Row | null, snapshots: 0 }
    _injectStateForTests({
      multiplier: PRECISION,
      totalCaw: 0n,
      capRatio: 0n,
      capLastUpdatedAt: 0n,
      ownership: new Map(),
      lastBlock: 0n,
      lastLogIndex: -1,
      halted: false,
    })

    await recordDeposit(fakeTx(db), {
      tokenId: 7,
      amountWei: 5n * PRECISION,
      blockNumber: L1_BLOCK,
      blockTimestamp: new Date(),
      txHash: '0xdep',
      logIndex: 21,
    })

    expect(db.row!.totalCaw).to.equal((5n * PRECISION).toString())
    expect(BigInt(db.row!.lastBlock)).to.equal(0n)
    expect(db.row!.lastLogIndex).to.equal(-1)
  })
})
