/**
 * POST /api/translate: what the per-IP limit (30 a minute) counts.
 *
 * A request the cache can answer calls no provider, so it must not use up the
 * limit; anything that does reach a provider, or that the handler refuses, still
 * counts. The router is mounted in a small express app (no database), and
 * `fetch` is replaced so that MyMemory, the keyless provider every node has,
 * answers from the test. Any other provider URL gets a 500, so the chain falls
 * through to MyMemory even if a translation key is set in the environment of the
 * test run. Each case uses its own client address (X-Forwarded-For), so the
 * counts do not meet.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

describe('POST /api/translate: the limit and the cache', function () {
  this.timeout(30000)

  let app: express.Express
  const realFetch = globalThis.fetch
  let providerCalls = 0
  let counter = 0
  const fresh = () => `a post nobody has translated yet, number ${++counter}`
  const LIMIT = 30

  before(async () => {
    const mod = await import('../../../src/api/routes/translate')
    app = express()
    app.set('trust proxy', 'loopback') // as the API server does; the test client is on loopback
    app.use(express.json())
    app.use('/api/translate', mod.default)

    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (!url.includes('api.mymemory.translated.net')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as any
      }
      providerCalls++
      const q = new URL(url).searchParams.get('q') || ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ responseStatus: 200, responseData: { translatedText: `translated: ${q}`, detectedLanguage: 'en' } }),
        text: async () => '',
      } as any
    }) as any
  })

  after(() => { globalThis.fetch = realFetch })

  const post = (ip: string, body: any) =>
    request(app).post('/api/translate').set('X-Forwarded-For', ip).send(body)

  it('answers from the cache do not use up the limit', async () => {
    const ip = '10.1.0.1'
    const text = fresh()
    const first = await post(ip, { text, targetLang: 'ja' })
    expect(first.status).to.equal(200)
    expect(first.body.cached).to.equal(false)
    const before = providerCalls
    for (let i = 0; i < LIMIT + 10; i++) {
      const r = await post(ip, { text, targetLang: 'ja' })
      expect(r.status, `repeat ${i}`).to.equal(200)
      expect(r.body.cached).to.equal(true)
    }
    expect(providerCalls).to.equal(before)
    // 41 requests so far from this address; a new text still gets through
    const other = await post(ip, { text: fresh(), targetLang: 'ja' })
    expect(other.status).to.equal(200)
  })

  it('requests that reach a provider are still limited to 30 a minute, with a Retry-After', async () => {
    const ip = '10.1.0.2'
    for (let i = 0; i < LIMIT; i++) {
      const r = await post(ip, { text: fresh(), targetLang: 'ja' })
      expect(r.status, `request ${i + 1}`).to.equal(200)
    }
    const before = providerCalls
    const over = await post(ip, { text: fresh(), targetLang: 'ja' })
    expect(over.status).to.equal(429)
    expect(over.body.error).to.match(/rate limit/i)
    expect(Number(over.headers['retry-after'])).to.be.greaterThan(0)
    expect(Number(over.headers['retry-after'])).to.be.at.most(60)
    expect(providerCalls).to.equal(before)
  })

  it('a text already in the cache is still answered at the limit', async () => {
    const ip = '10.1.0.3'
    const known = fresh()
    expect((await post(ip, { text: known, targetLang: 'ja' })).status).to.equal(200)
    for (let i = 1; i < LIMIT; i++) {
      expect((await post(ip, { text: fresh(), targetLang: 'ja' })).status).to.equal(200)
    }
    expect((await post(ip, { text: fresh(), targetLang: 'ja' })).status).to.equal(429)
    const again = await post(ip, { text: known, targetLang: 'ja' })
    expect(again.status).to.equal(200)
    expect(again.body.cached).to.equal(true)
  })

  it('the same text written another way finds the same entry', async () => {
    const ip = '10.1.0.4'
    const text = fresh()
    const first = await post(ip, { text, targetLang: 'ja' })
    expect(first.body.cached).to.equal(false)
    const second = await post(ip, { text: `  ${text}\n`, targetLang: 'JA-jp' })
    expect(second.status).to.equal(200)
    expect(second.body.cached).to.equal(true)
    expect(second.body.text).to.equal(first.body.text)
  })

  it('a language code the handler refuses is not skipped, even when it reads as a cached key', async () => {
    const ip = '10.1.0.8'
    const text = fresh()
    expect((await post(ip, { text, targetLang: 'ja' })).status).to.equal(200)
    // "auto" as a source reads as no source, the key of the entry just made; the handler refuses it
    for (let i = 1; i < LIMIT; i++) {
      const r = await post(ip, { text, targetLang: 'ja', sourceLang: 'auto' })
      expect(r.status, `request ${i}`).to.equal(400)
    }
    // all 30 were counted
    const over = await post(ip, { text, targetLang: 'ja', sourceLang: 'auto' })
    expect(over.status).to.equal(429)
  })

  it('a private text is not cached, so every request counts', async () => {
    const ip = '10.1.0.5'
    const text = fresh()
    for (let i = 0; i < LIMIT; i++) {
      const r = await post(ip, { text, targetLang: 'ja', isPrivate: true })
      expect(r.status, `request ${i + 1}`).to.equal(200)
      expect(r.body.cached).to.equal(false)
    }
    const over = await post(ip, { text, targetLang: 'ja', isPrivate: true })
    expect(over.status).to.equal(429)
  })

  it('a request the handler refuses still counts', async () => {
    const ip = '10.1.0.6'
    for (let i = 0; i < LIMIT; i++) {
      const r = await post(ip, { text: fresh() })
      expect(r.status, `request ${i + 1}`).to.equal(400)
    }
    const over = await post(ip, { text: fresh() })
    expect(over.status).to.equal(429)
  })

  it('a body the limit cannot read is left to the handler, which refuses it', async () => {
    const ip = '10.1.0.7'
    // What the handler answers for these is its own (a 400 or a 500); what is
    // checked is that the limit did not throw on them or let them through as
    // answered from the cache.
    const odd = await post(ip, { text: 'x', targetLang: 'ja', sourceLang: 42 })
    expect(odd.status).to.be.oneOf([400, 500])
    const noBody = await request(app).post('/api/translate').set('X-Forwarded-For', ip)
    expect(noBody.status).to.be.oneOf([400, 500])
    // both were counted: 2 of the 30 are used
    expect(Number(noBody.headers['ratelimit-remaining'])).to.equal(LIMIT - 2)
  })
})
