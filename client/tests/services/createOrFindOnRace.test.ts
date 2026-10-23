import { expect } from 'chai'
import { Prisma } from '@prisma/client'
import { createOrFindOnRace } from '../../src/utils/createOrFindOnRace'

function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  })
}

describe('createOrFindOnRace', () => {
  it('returns the created row and does not read back', async () => {
    let finds = 0
    const row = await createOrFindOnRace(async () => ({ id: 'a' }), async () => { finds++; return null })
    expect(row).to.deep.equal({ id: 'a' })
    expect(finds).to.equal(0)
  })

  it('returns the row another request created when the insert hits P2002', async () => {
    const row = await createOrFindOnRace(
      async () => { throw uniqueViolation() },
      async () => ({ id: 'dm:1:2' }),
    )
    expect(row).to.deep.equal({ id: 'dm:1:2' })
  })

  it('rethrows the P2002 when the row still is not there', async () => {
    const err = uniqueViolation()
    let caught: unknown
    try {
      await createOrFindOnRace(async () => { throw err }, async () => null)
    } catch (e) {
      caught = e
    }
    expect(caught).to.equal(err)
  })

  it('rethrows other errors without reading back', async () => {
    const err = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' })
    let finds = 0
    let caught: unknown
    try {
      await createOrFindOnRace(async () => { throw err }, async () => { finds++; return { id: 'a' } })
    } catch (e) {
      caught = e
    }
    expect(caught).to.equal(err)
    expect(finds).to.equal(0)
  })

  it('lets every one of N concurrent check-then-create calls finish with the same row', async () => {
    // The shape of the relay route: read, find nothing, then insert. The
    // await between the read and the insert lets all N pass the read first.
    const table = new Map<string, { id: string; by: number }>()
    const insert = async (by: number) => {
      if (table.has('dm:1:2')) throw uniqueViolation()
      const row = { id: 'dm:1:2', by }
      table.set(row.id, row)
      return row
    }
    const request = async (by: number) => {
      const existing = table.get('dm:1:2') ?? null
      await new Promise(resolve => setImmediate(resolve))
      return existing ?? createOrFindOnRace(() => insert(by), async () => table.get('dm:1:2') ?? null)
    }
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(request))
    expect(results.map(r => r.status)).to.deep.equal(Array(5).fill('fulfilled'))
    expect(table.size).to.equal(1)
    const winner = table.get('dm:1:2')
    for (const r of results) expect((r as PromiseFulfilledResult<unknown>).value).to.equal(winner)
  })
})
