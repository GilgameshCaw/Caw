import { describe, it } from 'mocha'
import { expect } from 'chai'
import { finalizeOwnPendingSubmissions } from '../../src/utils/archiveFinalize'

const NOW = 1000
const quiet = { log: () => {}, logError: () => {} }

// Mirrors CawActionsArchive: strict `>` on finalizedAt, swap-and-pop on finalize.
function fake(subs: Record<number, { finalizedAt: number; status: number }>, order: number[]) {
  const list = [...order]
  const calls: number[] = []
  const archive: any = {
    getValidatorSubmissionCount: async () => list.length,
    validatorSubmissions: async (_a: string, i: number) => list[i],
    getSubmission: async (id: number) => ['0x', '0x', 1, 0, 0, subs[id].finalizedAt, subs[id].status],
  }
  const archiveW: any = {
    finalizeSubmission: async (id: number) => {
      calls.push(id)
      const s = subs[id]
      if (s.status !== 0) { const e: any = new Error('x'); e.reason = 'Not pending'; throw e }
      if (!(NOW > s.finalizedAt)) throw new Error('Challenge period active')
      s.status = 1
      const idx = list.indexOf(id)
      const last = list.length - 1
      if (idx !== last) list[idx] = list[last]
      list.pop()
      return { wait: async () => ({}) }
    },
  }
  return { archive, archiveW, list, calls }
}

const run = (f: any) => finalizeOwnPendingSubmissions({ archive: f.archive, archiveW: f.archiveW, self: '0xabc', nowSec: NOW, ...quiet })

describe('finalizeOwnPendingSubmissions', () => {
  it('finalizes every due PENDING submission even though finalizing reshuffles the array', async () => {
    const f = fake({ 1: { finalizedAt: 10, status: 0 }, 2: { finalizedAt: 20, status: 0 }, 3: { finalizedAt: 30, status: 0 } }, [1, 2, 3])
    expect(await run(f)).to.deep.equal([1, 2, 3])
    expect(f.list).to.deep.equal([])
  })

  it('skips submissions still inside the challenge period, including exactly at finalizedAt', async () => {
    const f = fake({ 1: { finalizedAt: 1000, status: 0 }, 2: { finalizedAt: 999, status: 0 }, 3: { finalizedAt: 1001, status: 0 } }, [1, 2, 3])
    expect(await run(f)).to.deep.equal([2])
    expect(f.list.sort()).to.deep.equal([1, 3])
    expect(f.calls).to.deep.equal([2]) // no transaction is attempted before finalizedAt has passed
  })

  it('ignores submissions that are not PENDING', async () => {
    const f = fake({ 1: { finalizedAt: 10, status: 1 }, 2: { finalizedAt: 10, status: 2 }, 3: { finalizedAt: 10, status: 0 } }, [1, 2, 3])
    expect(await run(f)).to.deep.equal([3])
    expect(f.calls).to.deep.equal([3]) // no transaction is attempted for FINALIZED or SLASHED ones
  })

  it('carries on when finalize reverts with Not pending', async () => {
    const f = fake({ 1: { finalizedAt: 10, status: 0 }, 2: { finalizedAt: 10, status: 0 } }, [1, 2])
    const orig = f.archiveW.finalizeSubmission
    f.archiveW.finalizeSubmission = async (id: number) => {
      if (id === 1) { const e: any = new Error('x'); e.reason = 'Not pending'; throw e }
      return orig(id)
    }
    expect(await run(f)).to.deep.equal([2])
  })

  it('carries on when one submission cannot be read', async () => {
    const f = fake({ 1: { finalizedAt: 10, status: 0 }, 2: { finalizedAt: 10, status: 0 } }, [1, 2])
    const orig = f.archive.getSubmission
    f.archive.getSubmission = async (id: number) => { if (id === 1) throw new Error('rpc'); return orig(id) }
    expect(await run(f)).to.deep.equal([2])
  })

  it('returns nothing, without throwing, when the list cannot be read', async () => {
    const f = fake({}, [])
    f.archive.getValidatorSubmissionCount = async () => { throw new Error('rpc') }
    expect(await run(f)).to.deep.equal([])
  })
})
