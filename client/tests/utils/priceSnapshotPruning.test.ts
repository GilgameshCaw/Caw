import assert from 'node:assert/strict'
import { prisma } from '../../src/prismaClient'
import {
  cleanStalePriceSnapshots,
  parseDaysParam,
} from '../../src/utils/priceSnapshotPruning'

/**
 * The DB-backed tests delete rows, so they only run against a throwaway
 * database whose name starts with "caw_test_" (a schema-only copy, with
 * DATABASE_URL pointed at it). Anywhere else they are skipped, so `npm test`
 * on a machine whose DATABASE_URL is a real node database never touches it.
 *
 *   createdb caw_test_pricesnapshot   # then load the schema only (pg_dump -s)
 *   DATABASE_URL='postgresql://.../caw_test_pricesnapshot' \
 *     npx mocha --import=tsx --exit tests/utils/priceSnapshotPruning.test.ts
 */
const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000

// Fixtures are built from one fixed instant so that seeding twice gives identical rows.
const T0 = Date.now()

/** Start of the UTC hour that contains (T0 - daysAgo). */
function hourStart(daysAgo: number): number {
  const t = T0 - daysAgo * DAY_MS
  return Math.floor(t / HOUR_MS) * HOUR_MS
}

function rows(token: string, base: number, minutes: number[]) {
  return minutes.map((m) => ({
    token,
    usdPrice: 1 + m / 100,
    ethPrice: token === 'caw' ? 0.5 : null,
    createdAt: new Date(base + m * MIN_MS),
  }))
}

const every5 = Array.from({ length: 12 }, (_, i) => i * 5) // 0,5,...,55
const jittered = Array.from({ length: 12 }, (_, i) => i * 5 + 2) // 2,7,...,57 (never :00)

/** A fixed set of hours, none of which straddles a cutoff. */
async function seedFixture() {
  const data = [
    // 3 days old: inside the full-resolution window, all 24 rows must survive.
    ...rows('caw', hourStart(3), every5),
    ...rows('eth', hourStart(3), every5),
    // 10 days old, polls landed on :02,:07,... so there is NO :00 row.
    ...rows('caw', hourStart(10), jittered),
    ...rows('eth', hourStart(10), jittered),
    // 11 days old, includes a :00 row.
    ...rows('caw', hourStart(11), every5),
    ...rows('eth', hourStart(11), every5),
    // 12 days old, a single row (nothing to thin).
    ...rows('caw', hourStart(12), [33]),
    // 200 days old, three rows in one hour.
    ...rows('caw', hourStart(200), [1, 6, 11]),
  ]
  await prisma.priceSnapshot.createMany({ data })
  return data.length
}

async function survivors(): Promise<string[]> {
  const all = await prisma.priceSnapshot.findMany({ select: { token: true, createdAt: true } })
  return all.map((r) => `${r.token}@${r.createdAt.toISOString()}`).sort()
}

function count(list: string[], token: string, base: number): number {
  return list.filter((s) => {
    const [t, iso] = s.split('@')
    const ms = new Date(iso).getTime()
    return t === token && ms >= base && ms < base + HOUR_MS
  }).length
}

describe('parseDaysParam', () => {
  it('returns null for absent or empty values', () => {
    assert.equal(parseDaysParam(undefined), null)
    assert.equal(parseDaysParam(null), null)
    assert.equal(parseDaysParam(''), null)
  })

  it('accepts positive numbers given as strings or numbers', () => {
    assert.equal(parseDaysParam('90'), 90)
    assert.equal(parseDaysParam(30), 30)
    assert.equal(parseDaysParam('1.5'), 1.5)
  })

  it('rejects everything else', () => {
    for (const bad of ['abc', '0', '-3', 'Infinity', 'NaN', ['1', '2'], {}, true]) {
      assert.throws(() => parseDaysParam(bad, 'maxAgeDays'), RangeError, String(bad))
    }
  })
})

describe('cleanStalePriceSnapshots argument validation', () => {
  it('rejects unsafe arguments before touching the database', async () => {
    await assert.rejects(cleanStalePriceSnapshots({ thinAgeDays: 0 }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ thinAgeDays: -1 }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ thinAgeDays: NaN }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ thinAgeDays: 7, maxAgeDays: 7 }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ thinAgeDays: 7, maxAgeDays: 3 }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ batchSize: 0 }), RangeError)
    await assert.rejects(cleanStalePriceSnapshots({ batchSize: 1.5 }), RangeError)
  })
})

describeDb('cleanStalePriceSnapshots (disposable database)', () => {
  before(async () => {
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    assert.ok(db.startsWith('caw_test_'), `refusing to run against database "${db}"`)
  })

  beforeEach(async () => {
    await prisma.$executeRaw`DELETE FROM "PriceSnapshot"`
  })

  after(async () => {
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    if (db.startsWith('caw_test_')) await prisma.$executeRaw`DELETE FROM "PriceSnapshot"`
  })

  it('does nothing on an empty table', async () => {
    assert.deepEqual(await cleanStalePriceSnapshots(), { deleted: 0, thinned: 0, hardDeleted: 0 })
  })

  it('thins old rows to one per token per hour and keeps recent rows whole', async () => {
    const seeded = await seedFixture()
    assert.equal(seeded, 24 + 24 + 24 + 1 + 3 + 0) // 76

    const res = await cleanStalePriceSnapshots()
    // 10d: 11+11, 11d: 11+11, 200d: 2
    assert.deepEqual(res, { deleted: 46, thinned: 46, hardDeleted: 0 })

    const left = await survivors()
    assert.equal(left.length, seeded - 46)

    // Full resolution inside the window.
    assert.equal(count(left, 'caw', hourStart(3)), 12)
    assert.equal(count(left, 'eth', hourStart(3)), 12)
    // Hour without any :00 row is NOT wiped: exactly one row per token, the earliest (:02).
    assert.equal(count(left, 'caw', hourStart(10)), 1)
    assert.equal(count(left, 'eth', hourStart(10)), 1)
    assert.ok(left.includes(`caw@${new Date(hourStart(10) + 2 * MIN_MS).toISOString()}`))
    // Hour with a :00 row keeps that row.
    assert.equal(count(left, 'caw', hourStart(11)), 1)
    assert.ok(left.includes(`eth@${new Date(hourStart(11)).toISOString()}`))
    // Single-row hour untouched; ancient hour thinned but kept (no hard delete by default).
    assert.equal(count(left, 'caw', hourStart(12)), 1)
    assert.equal(count(left, 'caw', hourStart(200)), 1)
  })

  it('is idempotent', async () => {
    await seedFixture()
    await cleanStalePriceSnapshots()
    const before = await survivors()
    assert.deepEqual(await cleanStalePriceSnapshots(), { deleted: 0, thinned: 0, hardDeleted: 0 })
    assert.deepEqual(await survivors(), before)
  })

  it('gives the same result regardless of batch size', async () => {
    await seedFixture()
    await cleanStalePriceSnapshots({ batchSize: 2 })
    const small = await survivors()

    await prisma.$executeRaw`DELETE FROM "PriceSnapshot"`
    await seedFixture()
    await cleanStalePriceSnapshots({ batchSize: 5000 })
    assert.deepEqual(small, await survivors())
    assert.equal(small.length, 30)
  })

  it('hard-deletes rows past maxAgeDays when configured', async () => {
    await seedFixture()
    const res = await cleanStalePriceSnapshots({ maxAgeDays: 90 })
    assert.deepEqual(res, { deleted: 47, thinned: 44, hardDeleted: 3 })
    const left = await survivors()
    assert.equal(count(left, 'caw', hourStart(200)), 0)
    assert.equal(count(left, 'caw', hourStart(10)), 1)
    assert.equal(left.length, 29)
  })

  it('keeps the earliest row of the hour that straddles the cutoff and never touches newer rows', async () => {
    // The hour that contains (now - 7d): some rows fall before the cutoff, some after.
    const base = Math.floor((Date.now() - 7 * DAY_MS) / HOUR_MS) * HOUR_MS
    await prisma.priceSnapshot.createMany({ data: rows('caw', base, every5) })

    await cleanStalePriceSnapshots()
    const cutoffAfterRun = Date.now() - 7 * DAY_MS // >= the cutoff the run used
    const left = await prisma.priceSnapshot.findMany({ select: { createdAt: true }, orderBy: { createdAt: 'asc' } })
    const times = left.map((r) => r.createdAt.getTime())

    assert.equal(times[0], base, 'earliest row of the hour survives')
    for (const m of every5) {
      const t = base + m * MIN_MS
      if (t >= cutoffAfterRun) assert.ok(times.includes(t), `row at :${m} is newer than the cutoff and must survive`)
    }
  })
})
