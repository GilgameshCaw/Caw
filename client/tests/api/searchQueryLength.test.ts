import { expect } from 'chai'
import express from 'express'
import type { AddressInfo } from 'node:net'
import searchRouter from '../../src/api/routes/search'

// Only the status line matters here, and the 400 is decided before anything
// touches the database or Elasticsearch, so those cases need neither. A query
// that is accepted goes on to the database: with no DATABASE_URL it ends in a
// 500, with a test database in a 200, so "not 400" is the assertion. Those
// cases are skipped when DATABASE_URL points at a database that is not a test
// one, so this never queries a real database.

describe('GET /api/search query length', () => {
  let server: import('node:http').Server
  let base = ''

  before(async () => {
    const app = express()
    app.use('/api/search', searchRouter)
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/search`
  })

  after(() => { server.close() })

  const status = async (q: string) => (await fetch(`${base}?q=${encodeURIComponent(q)}&type=caws`)).status
  const url = process.env.DATABASE_URL
  const wouldQueryRealDatabase = !!url && !/test/i.test(url)

  it('rejects a single letter, digit or kana with 400', async () => {
    for (const q of ['a', '1', 'あ']) expect(await status(q), q).to.equal(400)
  })

  it('does not reject a single ideograph', async function () {
    if (wouldQueryRealDatabase) this.skip()
    for (const q of ['猫', '酒']) expect(await status(q), q).to.not.equal(400)
  })

  it('does not reject two characters', async function () {
    if (wouldQueryRealDatabase) this.skip()
    expect(await status('ab')).to.not.equal(400)
  })
})
