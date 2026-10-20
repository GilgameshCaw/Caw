import { expect } from 'chai'
import { splitAtBatchGroupBoundary } from '../../src/utils/bisectSplit'

type Row = { id: number; batchId?: number | null }

// Rows with no batchId: [{id:0}, {id:1}, ...]
const singles = (n: number): Row[] => Array.from({ length: n }, (_, id) => ({ id, batchId: null }))
// Rows from a layout like [null, 7, 7, 7, null]
const rows = (batchIds: Array<number | null | undefined>): Row[] => batchIds.map((batchId, id) => ({ id, batchId }))
const ids = (rs: Row[]) => rs.map(r => r.id)

// One ActionBatch sig covers every row of a batch group (CawActions
// _processBatchSig), so the validator's revert bisection must never send
// part of a group. These cover where the split falls.
describe('splitAtBatchGroupBoundary', () => {
  it('splits at Math.floor(n / 2) when there are no batch groups', () => {
    for (let n = 2; n <= 9; n++) {
      const halves = splitAtBatchGroupBoundary(singles(n))!
      expect(halves[0].length, `n=${n}`).to.equal(Math.floor(n / 2))
      expect(halves[1].length, `n=${n}`).to.equal(n - Math.floor(n / 2))
    }
  })

  it('treats undefined batchIds like null', () => {
    const halves = splitAtBatchGroupBoundary(rows([undefined, undefined, undefined]))!
    expect(halves.map(ids)).to.deep.equal([[0], [1, 2]])
  })

  it('moves the split to the group boundary nearest the middle', () => {
    // Plain mid = 3 would cut the group 7 at ids 2-4.
    const halves = splitAtBatchGroupBoundary(rows([null, null, 7, 7, 7, null]))!
    expect(halves.map(ids)).to.deep.equal([[0, 1], [2, 3, 4, 5]])
  })

  it('takes the lower boundary on a tie', () => {
    // Boundaries at 1 and 3, mid = 2.
    const halves = splitAtBatchGroupBoundary(rows([null, 7, 7, null]))!
    expect(halves.map(ids)).to.deep.equal([[0], [1, 2, 3]])
  })

  it('splits between two adjacent groups with different batchIds', () => {
    const halves = splitAtBatchGroupBoundary(rows([7, 7, 7, 8, 8]))!
    expect(halves.map(ids)).to.deep.equal([[0, 1, 2], [3, 4]])
  })

  // batchId alone can repeat (the API takes it from Date.now()), so the
  // group is (sender, batchId, batch sig), as in buildMultiActionData.
  const txRow = (id: number, senderId: number, batchId: number, signedTx: string) =>
    ({ id, batchId, signedTx, payload: { data: { senderId } } })

  it("splits two senders' batches that share a batchId", () => {
    const rs = [txRow(0, 10, 777, '0xaaa'), txRow(1, 10, 777, '0xaaa'), txRow(2, 20, 777, '0xbbb'), txRow(3, 20, 777, '0xbbb')]
    const halves = splitAtBatchGroupBoundary(rs)!
    expect(halves.map(h => h.map(r => r.id))).to.deep.equal([[0, 1], [2, 3]])
  })

  it("splits one sender's two batches that share a batchId", () => {
    const rs = [txRow(0, 10, 777, '0xaaa'), txRow(1, 10, 777, '0xaaa'), txRow(2, 10, 777, '0xccc')]
    const halves = splitAtBatchGroupBoundary(rs)!
    expect(halves.map(h => h.map(r => r.id))).to.deep.equal([[0, 1], [2]])
  })

  it('keeps one batch whole when its sender and sig match', () => {
    const rs = [txRow(0, 10, 777, '0xaaa'), txRow(1, 10, 777, '0xaaa'), txRow(2, 10, 777, '0xaaa')]
    expect(splitAtBatchGroupBoundary(rs)).to.equal(null)
  })

  it('returns null for a single row', () => {
    expect(splitAtBatchGroupBoundary(singles(1))).to.equal(null)
  })

  it('returns null for a single batch group', () => {
    expect(splitAtBatchGroupBoundary(rows([7, 7, 7, 7]))).to.equal(null)
  })

  it('returns null for no rows', () => {
    expect(splitAtBatchGroupBoundary([])).to.equal(null)
  })

  it('never cuts a group, on many generated layouts', () => {
    let seed = 1
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let t = 0; t < 500; t++) {
      const layout: Array<number | null> = []
      let nextBatch = 100
      while (layout.length < 2 + Math.floor(rand() * 30)) {
        if (rand() < 0.5) layout.push(null)
        else {
          const size = 2 + Math.floor(rand() * 5)
          const b = nextBatch++
          for (let k = 0; k < size; k++) layout.push(b)
        }
      }
      const rs = rows(layout)
      const halves = splitAtBatchGroupBoundary(rs)
      if (!halves) continue
      const [left, right] = halves
      expect(left.length).to.be.greaterThan(0)
      expect(right.length).to.be.greaterThan(0)
      expect(ids(left).concat(ids(right))).to.deep.equal(ids(rs))
      const last = left[left.length - 1].batchId
      expect(last != null && last === right[0].batchId, `layout ${JSON.stringify(layout)}`).to.equal(false)
    }
  })
})

// A model of bisectAndSubmit's recursion, not the function itself: the
// "submit" reverts when the sub-batch holds a bad row or only part of a
// batch group, the way CawActions does. It checks that splitting with
// the helper lets every row outside the bad row's group land.
describe('bisect recursion over splitAtBatchGroupBoundary (model)', () => {
  const groupOf = (all: Row[], r: Row) =>
    r.batchId == null ? [r.id] : all.filter(x => x.batchId === r.batchId).map(x => x.id)

  function bisect(all: Row[], sub: Row[], bad: Set<number>, landed: Set<number>, failed: Set<number>) {
    const subIds = new Set(ids(sub))
    const partialGroup = sub.some(r => groupOf(all, r).some(id => !subIds.has(id)))
    const hasBad = sub.some(r => bad.has(r.id))
    if (!partialGroup && !hasBad) { sub.forEach(r => landed.add(r.id)); return }
    const halves = splitAtBatchGroupBoundary(sub)
    if (!halves) { sub.forEach(r => failed.add(r.id)); return }
    bisect(all, halves[0], bad, landed, failed)
    bisect(all, halves[1], bad, landed, failed)
  }

  it('fails only the bad row, or the bad row\'s whole group', () => {
    const all = rows([null, 7, 7, 7, null, null, 8, 8, null, 9, 9, 9, 9, null])
    for (const badRow of all) {
      const landed = new Set<number>(), failed = new Set<number>()
      bisect(all, all, new Set([badRow.id]), landed, failed)
      expect([...failed].sort((a, b) => a - b), `bad=${badRow.id}`).to.deep.equal(groupOf(all, badRow))
      expect(landed.size + failed.size).to.equal(all.length)
    }
  })
})
