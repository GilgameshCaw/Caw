import { expect } from 'chai'

process.env.CLIENT_ID = '1'

import {
  recordDeposit,
  StakeLedgerRepairRequiredError,
  _injectStateForTests,
  _resetForTests,
} from '../../../src/services/StakeLedger/index'
import { PRECISION } from '../../../src/services/StakeLedger/contractMath'

describe('StakeLedger / recordDeposit repair guard', () => {
  beforeEach(() => {
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
  })

  it('throws repair-required instead of returning dedup null while halted', async () => {
    _injectStateForTests({
      networkId: 1,
      multiplier: PRECISION,
      totalCaw: 0n,
      ownership: new Map<number, bigint>(),
      lastBlock: 10n,
      lastLogIndex: 0,
      halted: true,
    } as any)

    let thrown: any = null
    try {
      await recordDeposit({} as any, {
        tokenId: 1,
        amountWei: 100n,
        blockNumber: 11n,
        blockTimestamp: new Date(),
        txHash: '0xrepairguard',
        logIndex: 0,
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).to.be.instanceOf(StakeLedgerRepairRequiredError)
  })
})
