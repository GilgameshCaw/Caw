// Paging through failed TxQueue rows (utils/failedTxQueuePage.ts): a full page
// moves the cursor on, a short page sends the next read back to the oldest row,
// and no row is skipped or read twice within one pass, including rows that share
// an updatedAt.
//
// The tests write rows, so they only run against a throwaway database whose name
// starts with "caw_test_" (a schema-only copy: pg_dump -s). Anywhere else they
// are skipped.
//
//   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_failedpage' \
//     npx mocha --import=tsx --exit tests/utils/failedTxQueuePage.test.ts

import { expect } from 'chai'
import { prisma } from '../../src/prismaClient'
import { readFailedTxQueuePage, type FailedTxQueueCursor } from '../../src/utils/failedTxQueuePage'

const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const SENDER = 96001
const HOUR = 60 * 60 * 1000
let nextCawonce = 1

async function insertRow(status: string, updatedAt: Date): Promise<number> {
  const iso = updatedAt.toISOString()
  const rows: any[] = await prisma.$queryRaw`
    INSERT INTO "TxQueue" ("payload", "signedTx", "status", "senderId", "cawonce", "createdAt", "updatedAt")
    VALUES ('{}'::jsonb, '0x', ${status}, ${SENDER}, ${nextCawonce++}, ${iso}::timestamp, ${iso}::timestamp)
    RETURNING "id"`
  return rows[0].id
}

/** n failed rows, one per `stepMs`, the oldest `n * stepMs` ago. Returns ids oldest first. */
async function insertFailed(n: number, stepMs = 1000): Promise<number[]> {
  const base = Date.now() - 2 * HOUR - n * stepMs
  const ids: number[] = []
  for (let i = 0; i < n; i++) ids.push(await insertRow('failed', new Date(base + i * stepMs)))
  return ids
}

/** Read pages until a read leaves no cursor, as the sweep does tick after tick. */
async function readPass(limit: number, olderThan: Date, maxPages = 50): Promise<number[][]> {
  const pages: number[][] = []
  let cursor: FailedTxQueueCursor | null = null
  for (let i = 0; i < maxPages; i++) {
    const page = await readFailedTxQueuePage({ cursor, limit, olderThan })
    pages.push(page.rows.map((r: any) => r.id))
    cursor = page.nextCursor
    if (!cursor) break
  }
  return pages
}

describeDb('readFailedTxQueuePage', function () {
  this.timeout(60000)

  const cutoff = () => new Date(Date.now() - 5 * 60 * 1000)

  beforeEach(async () => {
    nextCawonce = 1
    await prisma.$executeRaw`DELETE FROM "TxQueue" WHERE "senderId" = ${SENDER}`
  })
  after(async () => {
    await prisma.$executeRaw`DELETE FROM "TxQueue" WHERE "senderId" = ${SENDER}`
    await prisma.$disconnect()
  })

  it('reads every failed row once over a pass of full pages and a short last page', async () => {
    const ids = await insertFailed(25)
    const pages = await readPass(10, cutoff())
    expect(pages.map((p) => p.length)).to.deep.equal([10, 10, 5])
    expect(pages.flat()).to.deep.equal(ids)
  })

  it('with fewer rows than the limit, reads them all and leaves no cursor', async () => {
    const ids = await insertFailed(7)
    const page = await readFailedTxQueuePage({ cursor: null, limit: 500, olderThan: cutoff() })
    expect(page.rows.map((r: any) => r.id)).to.deep.equal(ids)
    expect(page.nextCursor).to.equal(null)
  })

  it('a row count that is an exact multiple of the limit ends with an empty page, then no cursor', async () => {
    const ids = await insertFailed(20)
    const pages = await readPass(10, cutoff())
    expect(pages.map((p) => p.length)).to.deep.equal([10, 10, 0])
    expect(pages.flat()).to.deep.equal(ids)
  })

  it('rows that share an updatedAt are neither skipped nor read twice across a page boundary', async () => {
    const same = new Date(Date.now() - 2 * HOUR)
    const ids: number[] = []
    for (let i = 0; i < 12; i++) ids.push(await insertRow('failed', same))
    const pages = await readPass(5, cutoff())
    expect(pages.flat()).to.deep.equal(ids)
  })

  it('a failed row that arrives while the cursor is partway through is read before the pass ends', async () => {
    const ids = await insertFailed(12)
    const first = await readFailedTxQueuePage({ cursor: null, limit: 5, olderThan: cutoff() })
    expect(first.nextCursor).to.not.equal(null)
    const late = await insertRow('failed', new Date(Date.now() - HOUR))
    const rest: number[] = []
    let cursor = first.nextCursor
    while (cursor) {
      const page = await readFailedTxQueuePage({ cursor, limit: 5, olderThan: cutoff() })
      rest.push(...page.rows.map((r: any) => r.id))
      cursor = page.nextCursor
    }
    expect(rest).to.deep.equal([...ids.slice(5), late])
  })

  it('does not read rows that are not failed or changed within the last five minutes', async () => {
    const ids = await insertFailed(3)
    await insertRow('pending', new Date(Date.now() - 2 * HOUR))
    await insertRow('done', new Date(Date.now() - 2 * HOUR))
    await insertRow('failed', new Date(Date.now() - 60 * 1000))
    const pages = await readPass(10, cutoff())
    expect(pages.flat()).to.deep.equal(ids)
  })

  it('a new pass after the last short page starts from the oldest row again', async () => {
    const ids = await insertFailed(15)
    await readPass(10, cutoff())
    const again = await readFailedTxQueuePage({ cursor: null, limit: 10, olderThan: cutoff() })
    expect(again.rows.map((r: any) => r.id)).to.deep.equal(ids.slice(0, 10))
  })

  it('1,200 failed rows with a limit of 500: three reads cover all of them', async () => {
    const ids = await insertFailed(1200, 10)
    const pages = await readPass(500, cutoff())
    expect(pages.map((p) => p.length)).to.deep.equal([500, 500, 200])
    expect(pages.flat()).to.deep.equal(ids)
  })
})
