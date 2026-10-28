/**
 * POST /api/notifications/test creates a notification for any userId from
 * any actorId, with no auth. It was closed only when NODE_ENV was
 * 'production', and `npm start` / `npm run api` don't set NODE_ENV, so a
 * node started that way left it open. It now opens only for
 * NODE_ENV=development.
 *
 * Only the gate is exercised: an empty body is answered 400 by the handler
 * before it touches the database, so "open" shows up as 400 and "closed"
 * as 403. Elasticsearch, Redis and Postgres point at closed ports, set
 * before the router is imported (importing it starts their clients).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

describe('POST /api/notifications/test is development-only', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    ELASTICSEARCH_NODE: process.env.ELASTICSEARCH_NODE,
    REDIS_URL: process.env.REDIS_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  }
  let app: express.Express

  before(async () => {
    process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1'
    process.env.REDIS_URL = 'redis://127.0.0.1:1/15'
    process.env.DATABASE_URL = 'postgresql://caw:caw@127.0.0.1:1/caw_test_unreachable'
    const { default: notificationsRouter } = await import('../../../src/api/routes/notifications')
    app = express()
    app.use(express.json())
    app.use('/api/notifications', notificationsRouter)
  })

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  for (const value of [undefined, '', 'production', 'test', 'staging']) {
    it(`closed when NODE_ENV is ${value === undefined ? 'unset' : `'${value}'`}`, async () => {
      if (value === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = value
      const res = await request(app).post('/api/notifications/test').send({})
      expect(res.status).to.equal(403)
    })
  }

  it("open when NODE_ENV is 'development'", async () => {
    process.env.NODE_ENV = 'development'
    const res = await request(app).post('/api/notifications/test').send({})
    expect(res.status).to.equal(400)
    expect(res.body.error).to.match(/required/)
  })
})
