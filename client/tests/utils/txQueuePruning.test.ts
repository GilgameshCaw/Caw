// Retention of final TxQueue rows: which rows go, which stay, and that the
// cutoff does not depend on the database session time zone.
//
// The database tests write rows, so they only run against a throwaway database
// whose name starts with "caw_test_" (a schema-only copy: pg_dump -s). Anywhere
// else they are skipped; the parsing tests always run.
//
//   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_txqueueprune' \
//     npx mocha --import=tsx --exit tests/utils/txQueuePruning.test.ts

import { expect } from 'chai'
import { prisma } from '../../src/prismaClient'
import {
  cleanStaleTxQueue,
  parseRetentionDays,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_DONE_RETENTION_DAYS,
} from '../../src/utils/txQueuePruning'

const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const SENDER = 95001
const OTHER = 95002
const DAY = 24 * 60 * 60 * 1000
let nextCawonce = 1

/** ISO time `days` days ago, moved `olderByMs` further into the past (negative = newer). */
const ago = (days: number, olderByMs = 0): string => new Date(Date.now() - days * DAY - olderByMs).toISOString()

async function insertRow(status: string, updatedAtIso: string, senderId = SENDER, cawonce?: number): Promise<number> {
  const cw = cawonce ?? nextCawonce++
  const rows: any[] = await prisma.$queryRaw`
    INSERT INTO "TxQueue" ("payload", "signedTx", "status", "senderId", "cawonce", "createdAt", "updatedAt")
    VALUES ('{}'::jsonb, '0x', ${status}, ${senderId}, ${cw}, ${updatedAtIso}::timestamp, ${updatedAtIso}::timestamp)
    RETURNING "id"`
  return rows[0].id
}

async function insertWithdrawal(userId: number, cawonce: number, status: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "WithdrawalRequest" ("userId", "amount", "status", "cawonce", "updatedAt")
    VALUES (${userId}, '1', ${status}, ${cawonce}, NOW())`
}

async function remainingIds(): Promise<number[]> {
  const rows: any[] = await prisma.txQueue.findMany({ where: { senderId: { in: [SENDER, OTHER] } }, select: { id: true } })
  return rows.map((r) => r.id).sort((a, b) => a - b)
}

async function reset(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "TxQueue" WHERE "senderId" IN (${SENDER}, ${OTHER})`
  await prisma.$executeRaw`DELETE FROM "WithdrawalRequest" WHERE "userId" IN (${SENDER}, ${OTHER})`
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof RangeError
  }
}

async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return pattern.test(String((err as Error)?.message))
  }
}

describe('parseRetentionDays', () => {
  it('uses the fallback when unset or blank', () => {
    expect(parseRetentionDays(undefined, 30)).to.deep.equal({ days: 30, valid: true })
    expect(parseRetentionDays('', 30)).to.deep.equal({ days: 30, valid: true })
    expect(parseRetentionDays('   ', 30)).to.deep.equal({ days: 30, valid: true })
  })

  it('accepts a whole number of days, with surrounding spaces', () => {
    expect(parseRetentionDays('1', 30)).to.deep.equal({ days: 1, valid: true })
    expect(parseRetentionDays(' 90 ', 30)).to.deep.equal({ days: 90, valid: true })
    expect(parseRetentionDays('36500', 30)).to.deep.equal({ days: 36500, valid: true })
  })

  it('treats "off" as disabled, in any case', () => {
    expect(parseRetentionDays('off', 30)).to.deep.equal({ days: null, valid: true })
    expect(parseRetentionDays('OFF', 30)).to.deep.equal({ days: null, valid: true })
  })

  it('switches the group off, and flags it, for anything unusable', () => {
    for (const bad of ['0', '-3', 'abc', '1.5', '1e3', '36501', '12d', 'null']) {
      expect(parseRetentionDays(bad, 30), bad).to.deep.equal({ days: null, valid: false })
    }
  })

  it('has the documented defaults', () => {
    expect(DEFAULT_FAILED_RETENTION_DAYS).to.equal(90)
    expect(DEFAULT_DONE_RETENTION_DAYS).to.equal(180)
  })
})

describeDb('cleanStaleTxQueue (disposable database)', function () {
  this.timeout(30000)

  before(async () => {
    const [{ db }]: any[] = await prisma.$queryRaw`SELECT current_database() AS db`
    if (!String(db).startsWith('caw_test_')) throw new Error(`refusing to run against database "${db}"`)
  })
  beforeEach(reset)
  after(reset)

  it('deletes failed-group rows older than the window and keeps newer ones', async () => {
    const old: number[] = []
    const fresh: number[] = []
    for (const s of ['failed', 'cancelled', 'underpriced', 'retried']) {
      old.push(await insertRow(s, ago(31)))
      fresh.push(await insertRow(s, ago(29)))
    }
    const res = await cleanStaleTxQueue({ failedDays: 30, doneDays: null })
    expect(res).to.deep.equal({ failedDeleted: 4, doneDeleted: 0, capped: false })
    expect(await remainingIds()).to.deep.equal(fresh.sort((a, b) => a - b))
  })

  it('deletes done-group rows older than the window and leaves the failed group alone when it is off', async () => {
    const oldDone = [await insertRow('done', ago(181)), await insertRow('validated_by_peer', ago(181))]
    const freshDone = [await insertRow('done', ago(179)), await insertRow('validated_by_peer', ago(179))]
    const oldFailed = await insertRow('failed', ago(400))
    const res = await cleanStaleTxQueue({ failedDays: null, doneDays: 180 })
    expect(res).to.deep.equal({ failedDeleted: 0, doneDeleted: 2, capped: false })
    expect(await remainingIds()).to.deep.equal([...freshDone, oldFailed].sort((a, b) => a - b))
    expect(oldDone).to.have.length(2)
  })

  it('never touches in-flight or unknown statuses, however old', async () => {
    const ids: number[] = []
    for (const s of ['pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit', 'waiting_for_session', 'some_future_status']) {
      ids.push(await insertRow(s, ago(4000)))
    }
    const res = await cleanStaleTxQueue({ failedDays: 1, doneDays: 1 })
    expect(res).to.deep.equal({ failedDeleted: 0, doneDeleted: 0, capped: false })
    expect(await remainingIds()).to.deep.equal(ids.sort((a, b) => a - b))
  })

  it('keeps a failed row that a pending withdrawal points at, and only that', async () => {
    const keptId = await insertRow('failed', ago(60), SENDER, 777)
    await insertWithdrawal(SENDER, 777, 'pending')
    await insertRow('failed', ago(60), SENDER, 778) // its withdrawal is already completed
    await insertWithdrawal(SENDER, 778, 'completed')
    await insertRow('failed', ago(60), SENDER, 779) // no withdrawal at all
    await insertRow('done', ago(400), SENDER, 781) // done group: the rule does not apply
    await insertWithdrawal(SENDER, 781, 'pending')
    await insertRow('failed', ago(60), SENDER, 782) // another user's pending withdrawal has the same cawonce
    await insertWithdrawal(OTHER, 782, 'pending')
    const res = await cleanStaleTxQueue({ failedDays: 30, doneDays: 180 })
    expect(res).to.deep.equal({ failedDeleted: 3, doneDeleted: 1, capped: false })
    expect(await remainingIds()).to.deep.equal([keptId])
  })

  it('is idempotent and gives the same result for any batch size', async () => {
    const build = async () => {
      for (let i = 0; i < 12; i++) await insertRow(i % 2 ? 'failed' : 'cancelled', ago(45))
      for (let i = 0; i < 7; i++) await insertRow('done', ago(200))
      for (let i = 0; i < 5; i++) await insertRow('done', ago(10))
    }
    await build()
    const small = await cleanStaleTxQueue({ failedDays: 30, doneDays: 180, batchSize: 2 })
    expect(small).to.deep.equal({ failedDeleted: 12, doneDeleted: 7, capped: false })
    expect(await remainingIds()).to.have.length(5)
    expect(await cleanStaleTxQueue({ failedDays: 30, doneDays: 180, batchSize: 2 })).to.deep.equal({ failedDeleted: 0, doneDeleted: 0, capped: false })

    await reset()
    await build()
    const large = await cleanStaleTxQueue({ failedDays: 30, doneDays: 180, batchSize: 5000 })
    expect(large).to.deep.equal(small)
  })

  it('does not depend on the database session time zone', async () => {
    // A cutoff passed as a JS Date is shifted by the session's UTC offset when the
    // session time zone is not UTC, which would delete the newer row here.
    const older = await insertRow('failed', ago(30, 30 * 60 * 1000))
    const newer = await insertRow('failed', ago(30, -30 * 60 * 1000))
    const res = await cleanStaleTxQueue({ failedDays: 30, doneDays: null })
    expect(res.failedDeleted).to.equal(1)
    expect(await remainingIds()).to.deep.equal([newer])
    expect(older).to.be.a('number')
  })

  it('does nothing when both groups are off', async () => {
    const id = await insertRow('failed', ago(4000))
    expect(await cleanStaleTxQueue({ failedDays: null, doneDays: null })).to.deep.equal({ failedDeleted: 0, doneDeleted: 0, capped: false })
    expect(await remainingIds()).to.deep.equal([id])
  })

  it('rejects invalid arguments before touching the database', async () => {
    const id = await insertRow('failed', ago(4000))
    for (const bad of [0, -1, 1.5, NaN, 36501]) {
      expect(await rejects(() => cleanStaleTxQueue({ failedDays: bad, doneDays: null })), `failedDays ${bad}`).to.equal(true)
      expect(await rejects(() => cleanStaleTxQueue({ failedDays: null, doneDays: bad })), `doneDays ${bad}`).to.equal(true)
    }
    for (const bad of [0, 1.5, 50001]) {
      expect(await rejects(() => cleanStaleTxQueue({ failedDays: 30, doneDays: 180, batchSize: bad })), `batchSize ${bad}`).to.equal(true)
    }
    expect(await remainingIds()).to.deep.equal([id])
  })

  it('stops at the batch limit and finishes in the next run', async () => {
    for (let i = 0; i < 12; i++) await insertRow(i % 2 ? 'failed' : 'cancelled', ago(100))
    const first = await cleanStaleTxQueue({ failedDays: 90, doneDays: null, batchSize: 2, maxBatches: 3 })
    expect(first).to.deep.equal({ failedDeleted: 6, doneDeleted: 0, capped: true })
    expect(await remainingIds()).to.have.length(6)
    const second = await cleanStaleTxQueue({ failedDays: 90, doneDays: null, batchSize: 2, maxBatches: 10 })
    expect(second).to.deep.equal({ failedDeleted: 6, doneDeleted: 0, capped: false })
    expect(await remainingIds()).to.have.length(0)
  })

  it('deletes nothing when the application clock and the database clock disagree', async () => {
    const id = await insertRow('failed', ago(4000))
    const wrongClock = Date.now() + 60 * 60 * 1000
    expect(await rejectsWith(() => cleanStaleTxQueue({ failedDays: 90, doneDays: 180, nowMs: wrongClock }), /clock/)).to.equal(true)
    expect(await remainingIds()).to.deep.equal([id])
    // A small difference is tolerated.
    const res = await cleanStaleTxQueue({ failedDays: 90, doneDays: 180, nowMs: Date.now() + 5 * 60 * 1000 })
    expect(res.failedDeleted).to.equal(1)
  })

  it('rejects invalid limits before touching the database', async () => {
    const id = await insertRow('failed', ago(4000))
    for (const bad of [0, 1.5, 10001]) {
      expect(await rejects(() => cleanStaleTxQueue({ failedDays: 30, doneDays: 180, maxBatches: bad })), `maxBatches ${bad}`).to.equal(true)
    }
    for (const bad of [999, 120001, NaN]) {
      expect(await rejects(() => cleanStaleTxQueue({ failedDays: 30, doneDays: 180, maxMs: bad })), `maxMs ${bad}`).to.equal(true)
    }
    expect(await remainingIds()).to.deep.equal([id])
  })
})
