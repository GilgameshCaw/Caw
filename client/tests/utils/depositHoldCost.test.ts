import { describe, it } from 'mocha'
import { expect } from 'chai'
import { depositHoldCostWei } from '../../src/utils/depositHoldCost'

const E18 = 10n ** 18n
const HASH = '0x' + 'ab'.repeat(32)
const row = (data: Record<string, unknown>, hash: string | null = HASH) => ({ pendingDepositTxHash: hash, payload: { data } })

describe('depositHoldCostWei', () => {
  it('is 0 with no rows, for a sender held only for the display hint', () => {
    expect(depositHoldCostWei([])).to.equal(0n)
  })

  it('adds the fixed cost and the signed tip', () => {
    expect(depositHoldCostWei([row({ actionType: 0, amounts: ['100'] })])).to.equal(5100n * E18)
    expect(depositHoldCostWei([row({ actionType: 1, amounts: ['100'] })])).to.equal(2100n * E18)
    expect(depositHoldCostWei([row({ actionType: 3, amounts: ['100'] })])).to.equal(4100n * E18)
    expect(depositHoldCostWei([row({ actionType: 4, amounts: ['100'] })])).to.equal(30100n * E18)
  })

  it('reads the action type by name too', () => {
    expect(depositHoldCostWei([row({ actionType: 'caw', amounts: [] })])).to.equal(5000n * E18)
    expect(depositHoldCostWei([row({ actionType: '0', amounts: [] })])).to.equal(5000n * E18)
  })

  it('counts every amount of a tip or a withdrawal, with no fixed cost', () => {
    expect(depositHoldCostWei([row({ actionType: 7, amounts: ['900', '100'] })])).to.equal(1000n * E18)
    expect(depositHoldCostWei([row({ actionType: 6, amounts: ['2500', '100'] })])).to.equal(2600n * E18)
  })

  it('charges nothing for an unlike or an unfollow with no tip', () => {
    expect(depositHoldCostWei([row({ actionType: 2 }), row({ actionType: 5, amounts: [] })])).to.equal(0n)
  })

  it('adds up every held row of a thread', () => {
    const thread = [1, 2, 3].map(() => row({ actionType: 0, amounts: ['100'] }))
    expect(depositHoldCostWei(thread)).to.equal(15300n * E18)
  })

  it('leaves out a row with no deposit hash', () => {
    expect(depositHoldCostWei([row({ actionType: 4, amounts: ['100'] }, null)])).to.equal(0n)
  })

  it('survives malformed rows and amounts', () => {
    expect(depositHoldCostWei([{ pendingDepositTxHash: HASH, payload: null }])).to.equal(0n)
    expect(depositHoldCostWei([row({ actionType: 0, amounts: ['x', '100'] })])).to.equal(5100n * E18)
    expect(depositHoldCostWei([row({ amounts: 'nope' })])).to.equal(0n)
  })
})
