import { expect } from 'chai'
import { settleEachWrite, failSubBatch, type SubBatchFailure } from '../../src/utils/subBatchFailure'

// The multi-network sub-batch in ValidatorService: its status writes, and
// what its catch writes when the error isn't transient.
type Row = { id: number }
const rows = (...ids: number[]): Row[] => ids.map(id => ({ id }))

describe('settleEachWrite', () => {
  it('waits for every write before returning, even after one throws', async () => {
    const calls: string[] = []
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>(resolve => { releaseSlow = resolve })
    const settled = settleEachWrite(rows(1, 2), async (row) => {
      if (row.id === 1) throw new Error('write 1 failed')
      await slow
      calls.push('wrote 2')
    }, (ids, err) => { calls.push(`failed ${ids}: ${(err as Error).message}`) })

    let done = false
    settled.then(() => { done = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(done).to.equal(false)

    releaseSlow()
    await settled
    expect(calls).to.deep.equal(['wrote 2', 'failed 1: write 1 failed'])
  })

  it('does not throw when a write throws synchronously', async () => {
    const failed: number[][] = []
    await settleEachWrite(rows(7), ((): Promise<unknown> => { throw new Error('sync') }) as any,
      (ids) => { failed.push(ids) })
    expect(failed).to.deep.equal([[7]])
  })
})

function catchWith(over: Partial<SubBatchFailure<Row>> & { processing?: number[] }) {
  const calls: string[] = []
  const processing = over.processing ?? [1, 2, 3]
  const f: SubBatchFailure<Row> = {
    entries: rows(1, 2, 3),
    sentIds: null,
    stillProcessing: async (ids) => {
      calls.push(`read ${ids}`)
      return ids.filter(id => processing.includes(id))
    },
    resetToPending: async (ids) => { calls.push(`pending ${ids}`) },
    markFailed: async (row) => { calls.push(`failed ${row.id}`) },
    writeFailed: (ids, err) => { calls.push(`write failed ${ids}: ${(err as Error).message}`) },
    ...over,
  }
  return { calls, f }
}

describe('failSubBatch', () => {
  it('fails every row still in processing when nothing was sent yet', async () => {
    const { calls, f } = catchWith({})
    await failSubBatch(f)
    expect(calls).to.deep.equal(['read 1,2,3', 'failed 1', 'failed 2', 'failed 3'])
  })

  it('puts rows that were not sent back to pending and fails only the sent ones', async () => {
    const { calls, f } = catchWith({ sentIds: new Set([1, 3]) })
    await failSubBatch(f)
    expect(calls).to.deep.equal(['pending 2', 'read 1,3', 'failed 1', 'failed 3'])
  })

  it('leaves a sent row that is no longer in processing', async () => {
    const { calls, f } = catchWith({ sentIds: new Set([1, 2, 3]), processing: [2] })
    await failSubBatch(f)
    expect(calls).to.deep.equal(['read 1,2,3', 'failed 2'])
  })

  it('fails no row when it cannot read their status', async () => {
    const { calls, f } = catchWith({
      sentIds: new Set([1]),
      stillProcessing: async () => { throw new Error('db down') },
    })
    await failSubBatch(f)
    expect(calls).to.deep.equal(['pending 2,3', 'write failed 1: db down'])
  })

  it('still fails the sent rows when the reset to pending throws', async () => {
    const { calls, f } = catchWith({
      sentIds: new Set([1]),
      resetToPending: async () => { throw new Error('reset failed') },
    })
    await failSubBatch(f)
    expect(calls).to.deep.equal(['write failed 2,3: reset failed', 'read 1', 'failed 1'])
  })

  it('writes the other rows when one failure write throws, and does not throw', async () => {
    const { calls, f } = catchWith({})
    f.markFailed = async (row) => {
      if (row.id === 2) throw new Error('write 2 failed')
      calls.push(`failed ${row.id}`)
    }
    await failSubBatch(f)
    expect(calls).to.deep.equal(['read 1,2,3', 'failed 1', 'failed 3', 'write failed 2: write 2 failed'])
  })
})
