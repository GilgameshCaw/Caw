/**
 * The marketplace routes that check `txHash` / `buyer` with a regular
 * expression must require a string first.
 *
 * RegExp#test coerces its argument to a string, so ["0x" + 64 hex digits]
 * (a one-element array, or a nested one) passes the format check and then
 * reaches code that expects a string: `buyer.toLowerCase()` throws (a 500
 * instead of a 400), and `txHash` goes into a log line, a Prisma `where`
 * and a Redis key as an array.
 *
 * No database, no Redis and no HTTP server: each test takes the route's own
 * handler out of the router and calls it with a minimal req/res, with the
 * Prisma calls the routes make replaced on the model delegates. The session
 * middleware in front of each route is not exercised here; the handler
 * reads the session the middleware would have set on req.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

const BUYER = '0x1111111111111111111111111111111111111111'
const SELLER = '0x3333333333333333333333333333333333333333'
const TX = '0x' + 'ab'.repeat(32)

describe('marketplace routes: txHash and buyer must be strings', function () {
  this.timeout(30000)

  const handlers: Record<string, (req: any, res: any) => Promise<unknown>> = {}
  let calls: string[]
  const restore: Array<() => void> = []

  function pick(router: any, path: string): (req: any, res: any) => Promise<unknown> {
    const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods.post)
    expect(layer, `${path} is registered`).to.not.equal(undefined)
    const stack = layer.route.stack.map((s: any) => s.handle)
    // [auth middleware, the handler]
    expect(stack, `${path}: middleware + handler`).to.have.length(2)
    return stack[1]
  }

  before(async () => {
    const { prisma } = await import('../../../src/prismaClient')
    const { default: router } = await import('../../../src/api/routes/marketplace')

    handlers.sold = pick(router, '/listings/:id/sold')
    handlers.accepted = pick(router, '/offers/:offerId/accepted')
    handlers.notify = pick(router, '/offers/notify')

    const stub = (model: string, name: string, result: () => unknown) => {
      const m: any = (prisma as any)[model]
      const had = Object.prototype.hasOwnProperty.call(m, name)
      const prev = m[name]
      m[name] = async () => { calls.push(`${model}.${name}`); return result() }
      restore.push(() => { if (had) m[name] = prev; else delete m[name] })
    }
    stub('marketplaceListing', 'findUnique', () => ({ id: 5, status: 'ACTIVE' }))
    stub('marketplaceOffer', 'findUnique', () => ({ offerId: 5, tokenId: 9, status: 'ACTIVE' }))
    stub('marketplaceOffer', 'findFirst', () => null)
    stub('user', 'findUnique', () => ({ address: SELLER }))
  })

  after(() => { restore.forEach(fn => fn()) })

  beforeEach(() => { calls = [] })

  async function call(name: string, params: any, body: any, addresses: string[]) {
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) { this.statusCode = code; return this },
      json(b: any) { this.body = b; return this },
    }
    const req: any = {
      params,
      body,
      sessionData: { authorizedAddresses: addresses, authorizedTokenIds: [7] },
    }
    await handlers[name](req, res)
    return { status: res.statusCode, json: res.body }
  }

  const sold = (body: any) => call('sold', { id: '5' }, body, [BUYER])
  const accepted = (body: any) => call('accepted', { offerId: '5' }, body, [SELLER])
  const notify = (body: any) => call('notify', {}, { senderTokenId: 7, ...body }, [SELLER])

  // Values that read as a valid hash or address once coerced to a string.
  const NOT_STRINGS = (valid: string): any[] => [[valid], [[valid]]]

  it('/listings/:id/sold: a valid string pair is accepted', async () => {
    const r = await sold({ txHash: TX, buyer: BUYER })
    expect(r.status).to.equal(200)
    expect(r.json).to.deep.equal({ ok: true, deferred: true })
  })

  it('/listings/:id/sold: rejects an array txHash with a 400, before any lookup', async () => {
    for (const txHash of NOT_STRINGS(TX)) {
      const r = await sold({ txHash, buyer: BUYER })
      expect(r.status, JSON.stringify(txHash)).to.equal(400)
    }
    expect(calls).to.deep.equal([])
  })

  it('/listings/:id/sold: rejects an array buyer with a 400, not a 500', async () => {
    for (const buyer of NOT_STRINGS(BUYER)) {
      const r = await sold({ txHash: TX, buyer })
      expect(r.status, JSON.stringify(buyer)).to.equal(400)
    }
    expect(calls).to.deep.equal([])
  })

  it('/offers/:offerId/accepted: a valid string pair is accepted', async () => {
    const r = await accepted({ txHash: TX, buyer: BUYER })
    expect(r.status).to.equal(202)
  })

  it('/offers/:offerId/accepted: rejects an array txHash with a 400, before any lookup', async () => {
    for (const txHash of NOT_STRINGS(TX)) {
      const r = await accepted({ txHash, buyer: BUYER })
      expect(r.status, JSON.stringify(txHash)).to.equal(400)
    }
    expect(calls).to.deep.equal([])
  })

  it('/offers/:offerId/accepted: rejects an array buyer with a 400, before any lookup', async () => {
    for (const buyer of NOT_STRINGS(BUYER)) {
      const r = await accepted({ txHash: TX, buyer })
      expect(r.status, JSON.stringify(buyer)).to.equal(400)
    }
    expect(calls).to.deep.equal([])
  })

  it('/offers/notify: rejects an array txHash with a 400, before any lookup', async () => {
    for (const txHash of NOT_STRINGS(TX)) {
      const r = await notify({ txHash })
      expect(r.status, JSON.stringify(txHash)).to.equal(400)
    }
    expect(calls).to.deep.equal([])
  })

  it('/offers/notify: a valid string txHash gets past validation to the offer lookup', async () => {
    // findFirst is stubbed to return null, so the route would go on to Redis
    // for the background retry; stop at the first lookup instead of running it.
    const r = await Promise.race([
      notify({ txHash: TX }),
      new Promise<any>(resolve => setTimeout(() => resolve({ status: 'pending' }), 1000)),
    ])
    expect(calls).to.include('marketplaceOffer.findFirst')
    expect(r.status).to.not.equal(400)
  })
})
