/**
 * Which TxQueue rows hold a cawonce, for GET /api/users/min-cawonce/:tokenId and
 * POST /api/users/check-cawonces (and /api/me, which shares the computation
 * through utils/minSafeCawonce.ts).
 *
 * A row that was accepted and has not reached a final state still holds its
 * cawonce, whatever its in-flight status is: pending, processing,
 * awaiting_indexer, waiting_for_deposit and waiting_for_session. So does an
 * underpriced row, whose signed payload can still be relayed to another
 * validator. Final rows do not count here: a confirmed one is in the Action
 * table, and a failed or cancelled one never used its cawonce. The lists used to
 * name only pending and processing.
 *
 * check-cawonces also has to refuse input that is not a whole number in range,
 * with a 400, where it used to hand it to Prisma and answer 500.
 *
 * The tests write rows and go through the real routers, so they only run against
 * a throwaway database whose name starts with "caw_test_" (a schema-only copy:
 * pg_dump -s). Anywhere else, or when another test file has already changed
 * DATABASE_URL in the same run, they are skipped.
 *
 *   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_cawonce' \
 *     npx mocha --import=tsx --exit tests/api/routes/cawonceReservation.test.ts
 *
 * The rows carry an empty payload on purpose: the routes read the cawonce column,
 * which every path that creates a TxQueue row sets.
 */
import { describe, it, before, beforeEach, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const SENDER = 96501
const OTHER = 96502

const HELD = ['pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit', 'waiting_for_session', 'underpriced']
const FINAL = ['done', 'validated_by_peer', 'failed', 'cancelled', 'retried']

;(HAS_TEST_DB ? describe : describe.skip)('TxQueue rows that hold a cawonce', function () {
  this.timeout(30000)

  let prisma: typeof import('../../../src/prismaClient').prisma
  let app: express.Express

  async function insertRow(status: string, cawonce: number, senderId = SENDER, payload = '{}') {
    await prisma.$executeRaw`
      INSERT INTO "TxQueue" ("payload", "signedTx", "status", "senderId", "cawonce", "updatedAt")
      VALUES (${payload}::jsonb, ${'0x' + Math.random().toString(16).slice(2)}, ${status}, ${senderId}, ${cawonce}, NOW())`
  }
  const reset = () => prisma.$executeRaw`DELETE FROM "TxQueue" WHERE "senderId" IN (${SENDER}, ${OTHER})`

  before(async function () {
    // Another test file in the same run can change DATABASE_URL after this file
    // was loaded, and then isolatedEnv refuses to load the app: skip, don't fail.
    try {
      await import('../../helpers/isolatedEnv')
    } catch {
      return this.skip()
    }
    ;({ prisma } = await import('../../../src/prismaClient'))
    const usersRouter = (await import('../../../src/api/routes/users')).default
    app = express()
    app.use(express.json())
    app.use('/api/users', usersRouter)
    await reset()
  })
  beforeEach(async () => { if (prisma) await reset() })
  after(async () => {
    if (!prisma) return
    await reset()
    await prisma.$disconnect()
  })

  const minCawonce = (tokenId: number) => request(app).get(`/api/users/min-cawonce/${tokenId}`)
  const check = (body: unknown) => request(app).post('/api/users/check-cawonces').send(body as object)

  describe('GET /api/users/min-cawonce/:tokenId', () => {
    it('is null when the sender has nothing in flight and nothing confirmed', async () => {
      const res = await minCawonce(SENDER)
      expect(res.status).to.equal(200)
      expect(res.body.minSafeCawonce).to.equal(null)
    })

    for (const status of HELD) {
      it(`counts a ${status} row`, async () => {
        await insertRow(status, 50)
        const res = await minCawonce(SENDER)
        expect(res.status).to.equal(200)
        expect(res.body.minSafeCawonce).to.equal(51)
      })
    }

    for (const status of FINAL) {
      it(`does not count a ${status} row`, async () => {
        await insertRow(status, 50)
        const res = await minCawonce(SENDER)
        expect(res.body.minSafeCawonce).to.equal(null)
      })
    }

    it('takes the highest held cawonce and ignores a higher final one', async () => {
      await insertRow('waiting_for_session', 10)
      await insertRow('awaiting_indexer', 12)
      await insertRow('failed', 99)
      const res = await minCawonce(SENDER)
      expect(res.body.minSafeCawonce).to.equal(13)
    })

    it('ignores another sender\'s rows', async () => {
      await insertRow('pending', 80, OTHER)
      const res = await minCawonce(SENDER)
      expect(res.body.minSafeCawonce).to.equal(null)
    })

    it('reads the cawonce column, not the payload', async () => {
      await insertRow('pending', 7, SENDER, JSON.stringify({ data: { cawonce: 500 } }))
      const res = await minCawonce(SENDER)
      expect(res.body.minSafeCawonce).to.equal(8)
    })
  })

  describe('POST /api/users/check-cawonces', () => {
    const refused: Array<[string, unknown]> = [
      ['no body fields', {}],
      ['a tokenId that is a string', { tokenId: String(SENDER), start: 1, count: 1 }],
      ['a tokenId of 0', { tokenId: 0, start: 1, count: 1 }],
      ['a tokenId past a 32-bit integer', { tokenId: 2 ** 31, start: 1, count: 1 }],
      ['a start that is a fraction', { tokenId: SENDER, start: 1.5, count: 1 }],
      ['a negative start', { tokenId: SENDER, start: -1, count: 1 }],
      ['a start too large for the search range', { tokenId: SENDER, start: 2 ** 31 - 100, count: 1 }],
      ['a count that is a fraction', { tokenId: SENDER, start: 1, count: 2.5 }],
      ['a count that is a string', { tokenId: SENDER, start: 1, count: '3' }],
    ]
    for (const [name, body] of refused) {
      it(`answers 400 for ${name}`, async () => {
        const res = await check(body)
        expect(res.status).to.equal(400)
      })
    }

    it('answers 400 for a start that JSON reads as Infinity', async () => {
      const res = await request(app)
        .post('/api/users/check-cawonces')
        .set('Content-Type', 'application/json')
        .send(`{"tokenId":${SENDER},"start":1e999,"count":1}`)
      expect(res.status).to.equal(400)
    })

    it('answers 400 for a request with no body', async () => {
      const res = await request(app).post('/api/users/check-cawonces')
      expect(res.status).to.equal(400)
    })

    it('answers 400 for a body that is not JSON', async () => {
      const res = await request(app)
        .post('/api/users/check-cawonces')
        .set('Content-Type', 'text/plain')
        .send('hello')
      expect(res.status).to.equal(400)
    })

    it('reports the in-flight and underpriced cawonces as used, and not the final ones', async () => {
      await insertRow('pending', 100)
      await insertRow('awaiting_indexer', 101)
      await insertRow('waiting_for_session', 102)
      await insertRow('underpriced', 103)
      await insertRow('done', 104)
      await insertRow('failed', 105)
      const res = await check({ tokenId: SENDER, start: 100, count: 6 })
      expect(res.status).to.equal(200)
      expect(res.body.used).to.deep.equal([100, 101, 102, 103])
    })

    it('finds the next block of free cawonces past the held ones', async () => {
      await insertRow('waiting_for_deposit', 100)
      await insertRow('waiting_for_session', 102)
      const res = await check({ tokenId: SENDER, start: 100, count: 2 })
      expect(res.body.used).to.deep.equal([100])
      expect(res.body.nextSafe).to.equal(103)
    })

    it('ignores rows outside the search range and other senders\' rows', async () => {
      const START = 100
      const COUNT = 3
      const SEARCH_END = START + COUNT + 200 // the last cawonce the route looks at
      await insertRow('pending', START - 50)
      await insertRow('pending', SEARCH_END + 3)
      await insertRow('pending', START + 1, OTHER)
      const res = await check({ tokenId: SENDER, start: START, count: COUNT })
      expect(res.body.used).to.deep.equal([])
      expect(res.body.nextSafe).to.equal(100)
    })
  })
})
