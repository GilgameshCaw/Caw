import { expect } from 'chai'
import {
  isCawonceUsedRejection,
  settleCawonceUsedRejection,
  type CawonceUsedResolution,
} from '../../src/utils/cawonceUsedRejection'

// A "Cawonce already used" rejection in a partly passing batch goes through
// resolveCawonceUsed, as it does when every row is rejected. These cover
// which status write each resolution makes.
function settlers(resolve: () => Promise<CawonceUsedResolution>, failWrite?: string) {
  const calls: string[] = []
  const write = (name: string, call: string) => async () => {
    if (name === failWrite) throw new Error(`${name} write failed`)
    calls.push(call)
  }
  return {
    calls,
    s: {
      resolve,
      markValidatedByPeer: write('markValidatedByPeer', 'validated_by_peer'),
      markAwaitingIndexer: write('markAwaitingIndexer', 'awaiting_indexer'),
      resetToPending: async (err: unknown) => {
        await write('resetToPending', `pending: ${(err as Error).message}`)()
      },
      writeFailed: (err: unknown) => { calls.push(`write failed: ${(err as Error).message}`) },
    },
  }
}

describe('isCawonceUsedRejection', () => {
  it('matches the decoded CawonceUsed rejection', () => {
    expect(isCawonceUsedRejection('CawonceUsed — Cawonce already used')).to.equal(true)
    expect(isCawonceUsedRejection('Cawonce already used')).to.equal(true)
  })

  it('does not match other rejections or a missing one', () => {
    expect(isCawonceUsedRejection('UserNotAuth — sender not authenticated on this Network')).to.equal(false)
    expect(isCawonceUsedRejection('')).to.equal(false)
    expect(isCawonceUsedRejection(undefined)).to.equal(false)
    expect(isCawonceUsedRejection(null)).to.equal(false)
  })
})

describe('settleCawonceUsedRejection', () => {
  it("marks the row validated_by_peer on 'done'", async () => {
    const { calls, s } = settlers(async () => 'done')
    expect(await settleCawonceUsedRejection(s)).to.equal('done')
    expect(calls).to.deep.equal(['validated_by_peer'])
  })

  it("moves the row to awaiting_indexer on 'awaiting_indexer'", async () => {
    const { calls, s } = settlers(async () => 'awaiting_indexer')
    expect(await settleCawonceUsedRejection(s)).to.equal('awaiting_indexer')
    expect(calls).to.deep.equal(['awaiting_indexer'])
  })

  it("writes nothing on 'failed', leaving the row to the caller", async () => {
    const { calls, s } = settlers(async () => 'failed')
    expect(await settleCawonceUsedRejection(s)).to.equal('failed')
    expect(calls).to.deep.equal([])
  })

  it('resets the row to pending when resolve throws, instead of throwing', async () => {
    const { calls, s } = settlers(async () => { throw new Error('getBlockNumber failed') })
    expect(await settleCawonceUsedRejection(s)).to.equal('retry')
    expect(calls).to.deep.equal(['pending: getBlockNumber failed'])
  })

  // The other rows of the batch were already submitted, so a failed status
  // write here must not throw into the batch's catch.
  it("returns 'retry' instead of throwing when the validated_by_peer write fails", async () => {
    const { calls, s } = settlers(async () => 'done', 'markValidatedByPeer')
    expect(await settleCawonceUsedRejection(s)).to.equal('retry')
    expect(calls).to.deep.equal(['write failed: markValidatedByPeer write failed'])
  })

  it("returns 'retry' instead of throwing when the awaiting_indexer write fails", async () => {
    const { calls, s } = settlers(async () => 'awaiting_indexer', 'markAwaitingIndexer')
    expect(await settleCawonceUsedRejection(s)).to.equal('retry')
    expect(calls).to.deep.equal(['write failed: markAwaitingIndexer write failed'])
  })

  it("returns 'retry' instead of throwing when resolve and the reset to pending both fail", async () => {
    const { calls, s } = settlers(async () => { throw new Error('getBlockNumber failed') }, 'resetToPending')
    expect(await settleCawonceUsedRejection(s)).to.equal('retry')
    expect(calls).to.deep.equal(['write failed: resetToPending write failed'])
  })
})
