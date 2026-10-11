import { expect } from 'chai'
import { assertStakeLedgerRepairAuthority } from '../../../scripts/stake-ledger-repair-authority'

describe('StakeLedger repair authority', () => {
  it('allows read-only execution without quiesced authority', () => {
    expect(() => assertStakeLedgerRepairAuthority(false, undefined)).not.to.throw()
  })

  it('refuses APPLY without quiesced authority', () => {
    expect(() => assertStakeLedgerRepairAuthority(true, undefined))
      .to.throw('refusing --apply without quiesced repair authority')
  })

  it('allows APPLY with quiesced authority', () => {
    expect(() => assertStakeLedgerRepairAuthority(true, '1')).not.to.throw()
  })
})
