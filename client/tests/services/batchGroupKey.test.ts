import { expect } from 'chai'
import { batchGroupKey, adjacentGroupSizes } from '../../src/utils/batchGroupKey'

type Row = { senderId: number; batchId: number | null; signedTx: string }

const row = (senderId: number, batchId: number | null, sig: string): Row => ({ senderId, batchId, signedTx: sig })

// master's rule (buildMultiActionData before this change): adjacent rows with
// the same non-null batchId are one group, whoever sent them.
function masterGroupSizes(rows: Row[]): number[] {
  const sizes: number[] = []
  let last: number | null | undefined = undefined
  for (const r of rows) {
    if (r.batchId != null && r.batchId === last && sizes.length > 0) sizes[sizes.length - 1] += 1
    else sizes.push(1)
    last = r.batchId ?? null
  }
  return sizes
}

describe('batchGroupKey / adjacentGroupSizes', () => {
  it('a row without a batchId has no key and is its own group', () => {
    expect(batchGroupKey(row(2, null, '0xa'))).to.equal(null)
    expect(adjacentGroupSizes([row(2, null, '0xa'), row(2, null, '0xb'), row(3, null, '0xc')])).to.deep.equal([1, 1, 1])
  })

  it("one batch's rows form one group", () => {
    const rows = [row(2, 777, '0xbatch'), row(2, 777, '0xbatch'), row(2, 777, '0xbatch')]
    expect(adjacentGroupSizes(rows)).to.deep.equal([3])
    expect(masterGroupSizes(rows)).to.deep.equal([3])
  })

  it("two senders' batches with the same batchId are two groups", () => {
    const rows = [row(2, 777, '0xA'), row(2, 777, '0xA'), row(3, 777, '0xB'), row(3, 777, '0xB')]
    expect(adjacentGroupSizes(rows)).to.deep.equal([2, 2])
    // control: master packs them as one group of 4 under sender 2's sig
    expect(masterGroupSizes(rows)).to.deep.equal([4])
  })

  it("one sender's two batches with the same batchId are two groups", () => {
    const rows = [row(2, 777, '0xA1'), row(2, 777, '0xA1'), row(2, 777, '0xA2'), row(2, 777, '0xA2')]
    expect(adjacentGroupSizes(rows)).to.deep.equal([2, 2])
    expect(masterGroupSizes(rows)).to.deep.equal([4])
  })

  it('a batch next to single rows and another batch keeps its boundaries', () => {
    const rows = [row(5, null, '0xs'), row(2, 10, '0xA'), row(2, 10, '0xA'), row(2, null, '0xt'), row(2, 11, '0xC'), row(2, 11, '0xC')]
    expect(adjacentGroupSizes(rows)).to.deep.equal([1, 2, 1, 2])
  })

  it('sizes always add up to the row count', () => {
    const rows = [row(1, 9, '0x1'), row(2, 9, '0x2'), row(2, 9, '0x2'), row(1, null, '0x3'), row(1, 9, '0x1')]
    const sizes = adjacentGroupSizes(rows)
    expect(sizes.reduce((a, b) => a + b, 0)).to.equal(rows.length)
    expect(sizes).to.deep.equal([1, 2, 1, 1])
  })
})
