import { expect } from 'chai'
import { resolveBisectTerminal } from '../../src/utils/bisectTerminal'

// Fakes for the chain read and the Action-table check, counting calls.
function fakes(used: boolean | Error, resolution: 'done' | 'failed' | 'awaiting_indexer' = 'awaiting_indexer') {
  const calls = { isCawonceUsed: 0, resolveCawonceUsed: 0 }
  const opts = {
    isCawonceUsed: async () => {
      calls.isCawonceUsed++
      if (used instanceof Error) throw used
      return used
    },
    resolveCawonceUsed: async () => {
      calls.resolveCawonceUsed++
      return resolution
    },
  }
  return { opts, calls }
}

// The last step of the validator's revert bisection (bisectAndSubmit) for
// a sub-batch that can't be split further and still reverted.
describe('resolveBisectTerminal', () => {
  it('calls an unused cawonce the reverter without checking the Action table', async () => {
    const { opts, calls } = fakes(false)
    expect(await resolveBisectTerminal(opts)).to.equal('reverted')
    expect(calls).to.deep.equal({ isCawonceUsed: 1, resolveCawonceUsed: 0 })
  })

  for (const r of ['done', 'failed', 'awaiting_indexer'] as const) {
    it(`passes a used cawonce on to resolveCawonceUsed (${r})`, async () => {
      const { opts, calls } = fakes(true, r)
      expect(await resolveBisectTerminal(opts)).to.equal(r)
      expect(calls).to.deep.equal({ isCawonceUsed: 1, resolveCawonceUsed: 1 })
    })
  }

  it('lets a failed chain read throw, without guessing a verdict', async () => {
    const { opts, calls } = fakes(new Error('missing response'))
    let thrown: any
    try { await resolveBisectTerminal(opts) } catch (e) { thrown = e }
    expect(thrown?.message).to.equal('missing response')
    expect(calls.resolveCawonceUsed).to.equal(0)
  })
})
