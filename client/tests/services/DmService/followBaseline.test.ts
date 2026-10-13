import { expect } from 'chai'
import {
  findDmBaselineFollow,
  _setPrismaForTest,
} from '../../../src/services/DmService/followBaseline'

// findDmBaselineFollow is the one Follow lookup behind DM first-contact
// routing (DmService, dm-relay.ts) and the cold/warm send bucket
// (dmRateLimit.ts). The fake client below applies the `where` it is
// given to an in-memory table, and throws on any operator it doesn't
// know, so a filter it can't evaluate fails the test instead of
// matching everything. Nothing touches Postgres.

type Row = { id: number; followerId: number; followingId: number; action: string; status: string }

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as any)[key]
    if (cond !== null && typeof cond === 'object') {
      const ops = Object.keys(cond)
      if (ops.length !== 1 || ops[0] !== 'in') throw new Error(`fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`)
      return ((cond as { in: unknown[] }).in).includes(value)
    }
    return value === cond
  })
}

function fakePrisma(rows: Row[]): any {
  return {
    follow: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const hit = rows.find((r) => matches(r, where))
        if (!hit) return null
        if (!select) return hit
        return Object.fromEntries(Object.keys(select).map((k) => [k, (hit as any)[k]]))
      },
    },
  }
}

function follow(status: string, action = 'FOLLOW'): Row {
  return { id: 1, followerId: 10, followingId: 20, action, status }
}

describe('findDmBaselineFollow', () => {
  afterEach(() => _setPrismaForTest(null))

  it('counts a confirmed follow', async () => {
    _setPrismaForTest(fakePrisma([follow('SUCCESS')]))
    expect(await findDmBaselineFollow(10, 20)).to.deep.equal({ id: 1 })
  })

  it('counts a PENDING follow (follow, then message straight away)', async () => {
    _setPrismaForTest(fakePrisma([follow('PENDING')]))
    expect(await findDmBaselineFollow(10, 20)).to.deep.equal({ id: 1 })
  })

  it('does not count a FAILED follow left behind by txQueueFailure', async () => {
    _setPrismaForTest(fakePrisma([follow('FAILED')]))
    expect(await findDmBaselineFollow(10, 20)).to.equal(null)
  })

  it('does not count a pending unfollow', async () => {
    _setPrismaForTest(fakePrisma([follow('PENDING', 'UNFOLLOW')]))
    expect(await findDmBaselineFollow(10, 20)).to.equal(null)
  })

  it('is directional', async () => {
    _setPrismaForTest(fakePrisma([follow('SUCCESS')]))
    expect(await findDmBaselineFollow(20, 10)).to.equal(null)
  })
})
