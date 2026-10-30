/**
 * Stripe card checkout.
 *
 * 1. The webhook signature is computed over the exact bytes Stripe sends.
 *    server.ts mounted the path's express.raw() after the global express.json(),
 *    so the handler got a parsed object and constructEvent rejected every event
 *    with 400. express.raw() now comes before the JSON parsers.
 * 2. The webhook mints through SponsorService.sponsorCardMint, which doesn't
 *    exist, so create-checkout now answers 503 until it does instead of
 *    sending the user to pay. It also answers 503 without
 *    STRIPE_WEBHOOK_SECRET, which the webhook needs to accept any event.
 *
 * server.ts can't be loaded here (it imports every router), so its parser order
 * is checked on the source, and the app below mounts the parsers in that order.
 * The real stripe router runs through supertest. prisma, SponsorService and
 * ChainSyncService are put in require.cache before stripe.ts loads, so nothing
 * connects to a database or a chain; constructEvent is a local HMAC check and
 * no request reaches Stripe.
 */

import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import Stripe from 'stripe'

const SECRET = 'whsec_test_dummy'
let sponsor: unknown = null

const stubs: Record<string, unknown> = {
  '../../../src/prismaClient': { prisma: {} },
  '../../../src/services/SponsorService': {
    getSponsorService: () => sponsor,
    isSponsorError: () => false,
  },
  '../../../src/services/ChainSyncService': { getCawPriceCache: () => null },
}

const saved = new Map<string, NodeJS.Module | undefined>()
const stripePath = require.resolve('../../../src/api/routes/stripe')
const envKeys = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const
const savedEnv: Record<string, string | undefined> = {}
let app: express.Express

function signed(payload: string) {
  return new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret: SECRET })
}

const event = JSON.stringify({ id: 'evt_test', object: 'event', type: 'payment_intent.created', data: { object: {} } })

describe('stripe card checkout', () => {
  before(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k]
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    for (const [rel, exports] of Object.entries(stubs)) {
      const p = require.resolve(rel)
      saved.set(p, require.cache[p])
      require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module
    }
    saved.set(stripePath, require.cache[stripePath])
    delete require.cache[stripePath]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stripeRouter = require('../../../src/api/routes/stripe').default
    // Same parser order as server.ts (checked on its source below).
    app = express()
    app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))
    app.use('/api/translate', express.json({ limit: '16kb' }))
    app.use(express.json({ limit: '50mb' }))
    app.post('/api/echo', (req, res) => res.json({ body: req.body }))
    app.use('/api/stripe', stripeRouter)
  })

  after(() => {
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  describe('webhook body', () => {
    it('server.ts mounts the webhook raw parser before any JSON parser', () => {
      const src = readFileSync(path.join(__dirname, '../../../src/api/server.ts'), 'utf8')
      const raw = src.indexOf("app.use('/api/stripe/webhook', express.raw(")
      const firstJson = src.search(/app\.use\([^)]*express\.json\(/)
      expect(raw, 'webhook raw mount').to.be.greaterThan(-1)
      expect(firstJson, 'json mount').to.be.greaterThan(-1)
      expect(raw).to.be.lessThan(firstJson)
    })

    it('a correctly signed event is accepted', async () => {
      const res = await request(app).post('/api/stripe/webhook')
        .set('content-type', 'application/json; charset=utf-8')
        .set('stripe-signature', signed(event))
        .send(event)
      expect(res.status).to.equal(200)
      expect(res.body).to.deep.equal({ received: true })
    })

    it('control: a bad signature is still rejected', async () => {
      const res = await request(app).post('/api/stripe/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', 't=1,v1=deadbeef')
        .send(event)
      expect(res.status).to.equal(400)
      expect(res.body.error).to.equal('Invalid webhook signature')
    })

    it('control: a signature over different bytes is rejected', async () => {
      const reformatted = JSON.stringify(JSON.parse(event), null, 2)
      const res = await request(app).post('/api/stripe/webhook')
        .set('content-type', 'application/json')
        .set('stripe-signature', signed(event))
        .send(reformatted)
      expect(res.status).to.equal(400)
    })

    it('control: other routes still get parsed JSON', async () => {
      const res = await request(app).post('/api/echo').send({ a: 1 })
      expect(res.body).to.deep.equal({ body: { a: 1 } })
    })
  })

  describe('create-checkout while the webhook cannot mint', () => {
    // Every request here carries an invalid username, so a route without the
    // gate stops at the zod check (400) and none of these ever calls Stripe.
    const invalidBody = {
      username: 'Not Valid',
      depositAmountUsd: 5,
      walletAddress: '0x1111111111111111111111111111111111111111',
    }

    it('answers 503 when the sponsor service is disabled', async () => {
      sponsor = null
      const res = await request(app).post('/api/stripe/create-checkout').send(invalidBody)
      expect(res.status).to.equal(503)
    })

    it('answers 503 when the sponsor service has no sponsorCardMint', async () => {
      sponsor = {}
      const res = await request(app).post('/api/stripe/create-checkout').send(invalidBody)
      expect(res.status).to.equal(503)
    })

    it('control: with sponsorCardMint present the request reaches validation', async () => {
      sponsor = { sponsorCardMint: async () => ({}) }
      const res = await request(app).post('/api/stripe/create-checkout').send(invalidBody)
      expect(res.status).to.equal(400)
      expect(res.body.error).to.equal('Invalid request')
    })

    it('answers 503 when STRIPE_WEBHOOK_SECRET is not set, even with sponsorCardMint', async () => {
      sponsor = { sponsorCardMint: async () => ({}) }
      delete process.env.STRIPE_WEBHOOK_SECRET
      try {
        const res = await request(app).post('/api/stripe/create-checkout').send(invalidBody)
        expect(res.status).to.equal(503)
      } finally {
        process.env.STRIPE_WEBHOOK_SECRET = SECRET
      }
    })
  })
})
