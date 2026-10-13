import { expect } from 'chai'
import type { RawAction } from '../../../src/services/ActionProcessor/types'

// resolveActionUsers pre-resolves users before the domain tx opens. These
// tests swap the user lookup through the module's test seam and record
// which tokenIds it was asked for. Nothing touches Postgres, Redis or L1.

type Mod = typeof import('../../../src/services/ActionProcessor/domainProcessor')
let mod: Mod
let prevNetworkId: string | undefined
let asked: number[]

// actionType numbers: 0 = CAW, 7 = OTHER (abi/getActionType.ts)
function raw(over: Partial<RawAction>): RawAction {
  return { actionType: 0, senderId: 1, networkId: 1, cawonce: 0, ...over } as unknown as RawAction
}

describe('resolveActionUsers', () => {
  before(async () => {
    // OUR_CLIENT_ID is read once at module load.
    prevNetworkId = process.env.NETWORK_ID
    process.env.NETWORK_ID = '1'
    mod = await import('../../../src/services/ActionProcessor/domainProcessor')
  })

  after(() => {
    mod._setFindOrCreateUserForTest(null)
    if (prevNetworkId === undefined) delete process.env.NETWORK_ID
    else process.env.NETWORK_ID = prevNetworkId
  })

  beforeEach(() => {
    asked = []
    mod._setFindOrCreateUserForTest(async (id) => { asked.push(id); return id })
  })

  it('pre-resolves every CAW-embedded tip recipient', async () => {
    await mod.resolveActionUsers(raw({ recipients: [7, 9], amounts: ['10', 20n] }))
    expect(asked).to.include.members([1, 7, 9])
  })

  it('skips recipients the in-tx loop skips (zero id or zero amount)', async () => {
    await mod.resolveActionUsers(raw({ recipients: [7, 0, 9], amounts: ['0', '5', '3'] }))
    expect(asked).to.include(9)
    expect(asked).to.not.include(7)
    expect(asked).to.not.include(0)
  })

  it('does not fail the action when a tip recipient lookup fails', async () => {
    mod._setFindOrCreateUserForTest(async (id) => {
      asked.push(id)
      if (id === 7) throw new Error('L1 query timed out after 15000ms')
      return id
    })
    const r = await mod.resolveActionUsers(raw({ recipients: [7, 9], amounts: ['1', '1'] }))
    expect(r.authorId).to.equal(1)
    expect(asked).to.include.members([7, 9])
  })

  it('still fails when the sender lookup fails', async () => {
    mod._setFindOrCreateUserForTest(async (id) => {
      if (id === 1) throw new Error('boom')
      return id
    })
    let err: unknown
    try { await mod.resolveActionUsers(raw({ recipients: [7], amounts: ['1'] })) } catch (e) { err = e }
    expect((err as Error)?.message).to.equal('boom')
  })

  it("leaves another network's CAW recipients alone (handleCawAction skips them)", async () => {
    await mod.resolveActionUsers(raw({ networkId: 2, recipients: [7], amounts: ['1'] }))
    expect(asked).to.deep.equal([1])
  })

  it('keeps OTHER at recipients[0] only', async () => {
    await mod.resolveActionUsers(raw({ actionType: 7, recipients: [7, 9], amounts: ['1', '1'] }))
    expect(asked).to.include(7)
    expect(asked).to.not.include(9)
  })
})
