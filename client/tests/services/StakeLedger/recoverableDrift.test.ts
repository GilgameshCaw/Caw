import { expect } from 'chai'

process.env.CLIENT_ID = '1'

import {
  recordAction,
  RecoverableStakeLedgerDriftError,
  _injectStateForTests,
  _peekState,
  _resetForTests,
  type RuntimeState,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

function makeState(): RuntimeState {
  return {
    multiplier: PRECISION,
    totalCaw: 0n,
    capRatio: PRECISION,
    capLastUpdatedAt: 0n,
    ownership: new Map([[1, 0n], [2, 0n], [3, 0n]]),
    lastBlock: 90n,
    lastLogIndex: 7,
    halted: false,
  }
}

function noWriteTx(): any {
  const fail = async () => {
    throw new Error('TEST FAILURE: DB persistence was reached')
  }

  return {
    $queryRawUnsafe: async () => [],
    stakeLedgerRepairGuard: { findUnique: async () => null },
    rewardMultiplierSnapshot: { createMany: fail },
    cawOwnershipSnapshot: { createMany: fail },
    cawOwnershipCurrent: { upsert: fail },
    user: { updateMany: fail },
    stakeLedgerState: { upsert: fail },
  }
}

function params(rawAction: any) {
  return {
    rawAction,
    validatorId: 3,
    blockNumber: 100n,
    blockTimestamp: new Date('2026-09-29T00:00:00Z'),
    txHash: '0x' + '11'.repeat(32),
    logIndex: 5,
    actionIndex: 0,
  }
}

async function expectRecoverable(rawAction: any, messagePart: string) {
  const oldState = makeState()
  _injectStateForTests(oldState)

  let thrown: any = null
  try {
    await recordAction(noWriteTx(), params(rawAction))
  } catch (err) {
    thrown = err
  }

  expect(thrown).to.be.instanceOf(RecoverableStakeLedgerDriftError)
  expect(thrown.message).to.include(messagePart)
  expect(thrown.blockNumber).to.equal(100n)
  expect(thrown.logIndex).to.equal(5)

  // No post-commit callback can have run and the singleton must remain untouched.
  expect(_peekState()).to.equal(oldState)
  expect(_peekState()!.halted).to.equal(false)
  expect(_peekState()!.lastBlock).to.equal(90n)
  expect(_peekState()!.lastLogIndex).to.equal(7)
  expect(_peekState()!.ownership.get(1)).to.equal(0n)
}

describe('StakeLedger / recoverable insufficient-balance drift', () => {
  beforeEach(() => {
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
  })

  it('Step1 throws recoverable drift instead of halting or persisting', async () => {
    await expectRecoverable(
      {
        senderId: 1,
        receiverId: 2,
        actionType: 1, // LIKE
        amounts: [],
        recipients: [],
        text: '',
      },
      'step1',
    )
  })

  it('WITHDRAW throws recoverable drift instead of halting or persisting', async () => {
    await expectRecoverable(
      {
        senderId: 1,
        receiverId: 0,
        actionType: 6, // WITHDRAW
        amounts: [1],
        recipients: [],
        text: '',
      },
      'WITHDRAW',
    )
  })

  it('Step2 throws recoverable drift instead of halting or persisting', async () => {
    await expectRecoverable(
      {
        senderId: 1,
        receiverId: 0,
        actionType: 7, // OTHER
        amounts: [1],
        recipients: [],
        text: '',
      },
      'step2',
    )
  })
})
