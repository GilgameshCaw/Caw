// client/tests/services/StakeLedger/hasExplicitTip.test.ts
import { expect } from 'chai'

process.env.CLIENT_ID = '1'
process.env.NETWORK_ID = '1'

import {
  recordAction,
  _peekState,
  _resetForTests,
  _injectStateForTests,
  type RuntimeState,
} from '../../../src/services/StakeLedger/index'
import {
  PRECISION,
  balanceOf,
  ownershipFromBalance,
} from '../../../src/services/StakeLedger/contractMath'
import type { RawAction } from '../../../src/services/ActionProcessor/types'

function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    multiplier: PRECISION,
    totalCaw: 1_000_000n * PRECISION,
    capRatio: 0n,
    capLastUpdatedAt: 0n,
    ownership: new Map(),
    lastBlock: 100n,
    lastLogIndex: 0,
    halted: false,
    ...overrides,
  }
}

function makeMockTx() {
  const touches: any[] = []
  const tx: any = {
    rewardMultiplierSnapshot: { createMany: async () => ({ count: 0 }) },
    cawOwnershipSnapshot: {
      createMany: async ({ data }: { data: any[] }) => {
        touches.push(...data)
        return { count: data.length }
      },
    },
    cawOwnershipCurrent: { upsert: async (args: any) => args },
    user: { updateMany: async () => ({ count: 1 }) },
    stakeLedgerState: { upsert: async (args: any) => args },
  }
  return { tx, touches }
}

const baseParams = {
  validatorId: 10,
  blockNumber: 101n,
  blockTimestamp: new Date(1700000000000),
  txHash: '0xabc123',
  logIndex: 0,
  actionIndex: 0,
}

describe('StakeLedger / hasExplicitTip logic in recordAction', () => {
  beforeEach(() => { _resetForTests() })
  afterEach(() => { _resetForTests() })

  it('1. WITHDRAW with no tip slot (amounts=[X]) debits sender once and does NOT halt on 100% unstake', async () => {
    const senderId = 1
    const validatorId = 10
    const withdrawAmount = 100n
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(100n * PRECISION, PRECISION)],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 6, // WITHDRAW
      senderId,
      cawonce: 1,
      text: '0x',
      recipients: [senderId],
      amounts: [withdrawAmount],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(s.halted).to.equal(false, 'ledger must not halt on 100% balance withdrawal')
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(s.totalCaw).to.equal(900n * PRECISION)
    expect(mockTx.touches).to.have.lengthOf(1)
    expect(mockTx.touches[0].reason).to.equal('ACTION_SPEND_BASE')
    expect(BigInt(mockTx.touches[0].delta)).to.equal(-100n * PRECISION)
  })

  it('2. WITHDRAW with no tip slot (partial unstake) leaves remaining balance intact and pays 0 to validator', async () => {
    const senderId = 1
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(200n * PRECISION, PRECISION)],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 6,
      senderId,
      cawonce: 1,
      text: '0x',
      recipients: [senderId],
      amounts: [100n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(s.halted).to.equal(false)
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(100n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(mockTx.touches).to.have.lengthOf(1)
  })

  it('3. WITHDRAW with explicit tip (amounts=[withdrawAmount, tipAmount]) debits both and credits validator', async () => {
    const senderId = 1
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(105n * PRECISION, PRECISION)],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 6,
      senderId,
      cawonce: 1,
      text: '0x',
      recipients: [senderId],
      amounts: [100n, 5n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(s.halted).to.equal(false)
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(5n * PRECISION)
    expect(mockTx.touches).to.have.lengthOf(3)
    const reasons = mockTx.touches.map((t: any) => t.reason)
    expect(reasons).to.include('ACTION_SPEND_BASE')
    expect(reasons).to.include('ACTION_SPEND_VALIDATOR_TIP')
    expect(reasons).to.include('ACTION_VALIDATOR')
  })

  it('4. single-recipient tip without explicit tip pays only recipient and 0 to validator', async () => {
    const senderId = 1
    const bobId = 2
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(50n * PRECISION, PRECISION)],
      [bobId, 0n],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 7, // OTHER
      senderId,
      receiverId: bobId,
      cawonce: 1,
      text: `tip:${bobId}:0`,
      recipients: [bobId],
      amounts: [50n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(s.halted).to.equal(false)
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(balanceOf(s.ownership.get(bobId) ?? 0n, s.multiplier)).to.equal(50n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(0n)
  })

  it('5. single-recipient tip WITH explicit tip pays both recipient and validator', async () => {
    const senderId = 1
    const bobId = 2
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(55n * PRECISION, PRECISION)],
      [bobId, 0n],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 7,
      senderId,
      receiverId: bobId,
      cawonce: 1,
      text: `tip:${bobId}:0`,
      recipients: [bobId],
      amounts: [50n, 5n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(s.halted).to.equal(false)
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(balanceOf(s.ownership.get(bobId) ?? 0n, s.multiplier)).to.equal(50n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(5n * PRECISION)
  })

  it('6. multi-recipient tip without explicit tip pays all recipients and 0 to validator', async () => {
    const senderId = 1
    const bobId = 2
    const charlieId = 3
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(80n * PRECISION, PRECISION)],
      [bobId, 0n],
      [charlieId, 0n],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 7,
      senderId,
      cawonce: 1,
      text: 'tip-multi',
      recipients: [bobId, charlieId],
      amounts: [50n, 30n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(0n)
    expect(balanceOf(s.ownership.get(bobId) ?? 0n, s.multiplier)).to.equal(50n * PRECISION)
    expect(balanceOf(s.ownership.get(charlieId) ?? 0n, s.multiplier)).to.equal(30n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(0n)
  })

  it('7. zero-recipient action with explicit tip pays validator fee', async () => {
    const senderId = 1
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(10n * PRECISION, PRECISION)],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 7,
      senderId,
      cawonce: 1,
      text: 'vote:1:1',
      recipients: [],
      amounts: [5n],
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(5n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(5n * PRECISION)
  })

  it('8. WITHDRAW with additional recipient records recipient correctly without sender self-tip', async () => {
    const senderId = 1
    const bobId = 2
    const validatorId = 10
    const ownership = new Map<number, bigint>([
      [senderId, ownershipFromBalance(150n * PRECISION, PRECISION)],
      [bobId, 0n],
      [validatorId, 0n]
    ])
    _injectStateForTests(makeState({ ownership, totalCaw: 1000n * PRECISION }))
    const mockTx = makeMockTx()

    const rawAction: RawAction = {
      actionType: 6,
      senderId,
      cawonce: 1,
      text: '0x',
      recipients: [senderId, bobId],
      amounts: [100n, 20n], // 100 withdraw, 20 to Bob, 0 tip
    }

    const commit = await recordAction(mockTx.tx, { ...baseParams, validatorId, rawAction })
    expect(commit).to.be.a('function')
    commit!()

    const s = _peekState()!
    expect(balanceOf(s.ownership.get(senderId) ?? 0n, s.multiplier)).to.equal(30n * PRECISION)
    expect(balanceOf(s.ownership.get(bobId) ?? 0n, s.multiplier)).to.equal(20n * PRECISION)
    expect(balanceOf(s.ownership.get(validatorId) ?? 0n, s.multiplier)).to.equal(0n)
    const tipTouch = mockTx.touches.find((t: any) => t.reason === 'ACTION_SPEND_TIP')
    expect(tipTouch).to.exist
    expect(tipTouch.counterpartyTokenId).to.equal(bobId, 'counterparty must be Bob, not senderId')
  })
})
