import { expect } from 'chai'

process.env.CLIENT_ID = '1'

import {
  ensureBooted,
  isRepairRequired,
  markRepairRequired,
  _resetForTests,
  _setPrismaForTests,
  _setActionsContractForTests,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

describe('StakeLedger / repairRequired restart guard', () => {
  beforeEach(() => {
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
  })

  it('reads the durable repair guard without booting the full StakeLedger', async () => {
    _setPrismaForTests({
      stakeLedgerRepairGuard: {
        findUnique: async () => ({ repairRequired: true }),
      },
    } as any)

    expect(await isRepairRequired()).to.equal(true)
  })

  it('treats a missing StakeLedgerState row as not repair-required', async () => {
    _setPrismaForTests({
      stakeLedgerRepairGuard: {
        findUnique: async () => null,
      },
    } as any)

    expect(await isRepairRequired()).to.equal(false)
  })

  it('persists repair-required independently when StakeLedgerState is missing', async () => {
    let guardUpsert: any = null

    const tx = {
      $queryRawUnsafe: async () => [],
      stakeLedgerRepairGuard: {
        upsert: async (args: any) => {
          guardUpsert = args
          return {}
        },
      },
    }

    _setPrismaForTests({
      stakeLedgerState: {
        findUnique: async () => null,
      },
      stakeLedgerRepairGuard: {
        findUnique: async () => null,
      },
      cawOwnershipCurrent: {
        findMany: async () => [],
      },
      chainData: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
      $transaction: async (fn: any) => await fn(tx),
    } as any)

    _setActionsContractForTests({
      capState: async () => [0n, 0n],
    })

    await markRepairRequired()

    expect(guardUpsert).to.not.equal(null)
    expect(guardUpsert.where.networkId).to.equal(1)
    expect(guardUpsert.create.repairRequired).to.equal(true)
    expect(guardUpsert.update.repairRequired).to.equal(true)
  })

  it('restores halted=true from the independent guard even when StakeLedgerState is missing', async () => {
    _setPrismaForTests({
      stakeLedgerState: {
        findUnique: async () => null,
      },
      stakeLedgerRepairGuard: {
        findUnique: async () => ({ repairRequired: true }),
      },
      cawOwnershipCurrent: {
        findMany: async () => [],
      },
      chainData: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
    } as any)

    _setActionsContractForTests({
      capState: async () => [0n, 0n],
    })

    const booted = await ensureBooted()

    expect(booted.halted).to.equal(true)
    expect(booted.lastBlock).to.equal(0n)
    expect(booted.lastLogIndex).to.equal(-1)
  })

  it('restores halted=true from durable repairRequired=true after process-memory reset', async () => {
    const mockPrisma = {
      stakeLedgerState: {
        findUnique: async () => ({
          networkId: 1,
          multiplier: PRECISION.toString(),
          totalCaw: '1234',
          lastBlock: 100n,
          lastLogIndex: 7,
          updatedAt: new Date(),
        }),
      },
      stakeLedgerRepairGuard: {
        findUnique: async () => ({ repairRequired: true }),
      },
      cawOwnershipCurrent: {
        findMany: async () => [
          { tokenId: 1, ownership: '500' },
        ],
      },
      chainData: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
    }

    _setPrismaForTests(mockPrisma as any)
    _setActionsContractForTests({
      capState: async () => [0n, 0n],
    })

    const booted = await ensureBooted()

    expect(booted.halted).to.equal(true)
    expect(booted.lastBlock).to.equal(100n)
    expect(booted.lastLogIndex).to.equal(7)
    expect(booted.ownership.get(1)).to.equal(500n)
  })
})
