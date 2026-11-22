/**
 * POST /api/marketplace/offers/:offerId/cancelled must not write the offer
 * status itself.
 *
 * The status change comes from the OfferCancelled event (the indexer only
 * moves ACTIVE rows). If this route flipped the row to CANCELLED on the
 * caller's say-so (the txHash is not checked against the chain), a call
 * without a real cancel would leave the row CANCELLED while the offer is
 * still active on-chain, and a later OfferAccepted could not move it.
 * /offers/:offerId/accepted and /listings/:id/sold already work this way.
 *
 * No database, no Redis and no HTTP server: the test takes the route's own
 * handler out of the router and calls it with a minimal req/res, with the
 * two Prisma calls it makes replaced on the model delegate. The session
 * middleware in front of it (requireAuth) is not exercised here; the
 * handler reads the session the middleware would have set on req.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

const OFFERER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const TX = '0x' + 'ab'.repeat(32)

describe('POST /api/marketplace/offers/:offerId/cancelled', function () {
  this.timeout(30000)

  let handler: (req: any, res: any) => Promise<unknown>
  let offerRow: any = null
  let calls: { findUnique: any[]; update: any[]; updateMany: any[] }
  const restore: Array<() => void> = []

  before(async () => {
    const { prisma } = await import('../../../src/prismaClient')
    const { default: marketplaceRouter } = await import('../../../src/api/routes/marketplace')

    const layer = (marketplaceRouter as any).stack.find(
      (l: any) => l.route && l.route.path === '/offers/:offerId/cancelled' && l.route.methods.post,
    )
    expect(layer, 'route is registered').to.not.equal(undefined)
    const handlers = layer.route.stack.map((s: any) => s.handle)
    // [requireAuth({ anySession: true }), the handler]
    expect(handlers, 'middleware + handler').to.have.length(2)
    handler = handlers[1]

    const offerModel: any = (prisma as any).marketplaceOffer
    for (const name of ['findUnique', 'update', 'updateMany'] as const) {
      const had = Object.prototype.hasOwnProperty.call(offerModel, name)
      const prev = offerModel[name]
      offerModel[name] = async (args: any) => {
        calls[name].push(args)
        return name === 'findUnique' ? offerRow : { count: 1 }
      }
      restore.push(() => { if (had) offerModel[name] = prev; else delete offerModel[name] })
    }
  })

  after(() => { restore.forEach(fn => fn()) })

  beforeEach(() => {
    calls = { findUnique: [], update: [], updateMany: [] }
    offerRow = { offerId: 5, tokenId: 9, offerer: OFFERER, status: 'ACTIVE' }
  })

  async function post(body: any, addresses: string[] = [OFFERER]) {
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) { this.statusCode = code; return this },
      json(b: any) { this.body = b; return this },
    }
    const req: any = {
      params: { offerId: '5' },
      body,
      sessionData: { authorizedAddresses: addresses, authorizedTokenIds: [7] },
    }
    await handler(req, res)
    return { status: res.statusCode, json: res.body }
  }

  function noStatusWrite() {
    expect(calls.update, 'update calls').to.have.length(0)
    expect(calls.updateMany, 'updateMany calls').to.have.length(0)
  }

  it('answers 202 for the offerer and leaves the status to the indexer', async () => {
    const r = await post({ txHash: TX })
    expect(r.status).to.equal(202)
    expect(r.json).to.deep.equal({ ok: true, message: 'Event will be processed by indexer' })
    expect(calls.findUnique).to.have.length(1)
    noStatusWrite()
  })

  it('does not write for a call that has no real cancel behind it (any well-formed txHash)', async () => {
    const r = await post({ txHash: '0x' + '00'.repeat(32) })
    expect(r.status).to.equal(202)
    noStatusWrite()
  })

  it('rejects a session that is not the offerer, without a write', async () => {
    const r = await post({ txHash: TX }, [OTHER])
    expect(r.status).to.equal(403)
    noStatusWrite()
  })

  it('answers 404 for an unknown offer', async () => {
    offerRow = null
    const r = await post({ txHash: TX })
    expect(r.status).to.equal(404)
    noStatusWrite()
  })

  it('does nothing for an offer that is no longer ACTIVE', async () => {
    offerRow = { ...offerRow, status: 'ACCEPTED' }
    const r = await post({ txHash: TX })
    expect(r.status).to.equal(200)
    expect(r.json).to.deep.equal({ ok: true })
    noStatusWrite()
  })

  it('rejects a missing or malformed txHash before looking the offer up', async () => {
    for (const body of [{}, { txHash: '' }, { txHash: '0x12' }, { txHash: 'not a hash' }, { txHash: TX + '\nfake log line' }]) {
      const r = await post(body)
      expect(r.status, JSON.stringify(body)).to.equal(400)
    }
    expect(calls.findUnique).to.have.length(0)
    noStatusWrite()
  })

  it('rejects a txHash that is not a string, even when it would read as a valid hash', async () => {
    // A one-element array (or a nested one) turns into the hash text when the
    // regular expression coerces it, so the format check alone lets it through.
    const bad: any[] = [[TX], [[TX]], { txHash: TX }, 123, true, null]
    for (const txHash of bad) {
      const r = await post({ txHash })
      expect(r.status, JSON.stringify(txHash)).to.equal(400)
    }
    expect(calls.findUnique).to.have.length(0)
    noStatusWrite()
  })

  it('still answers 202 for a valid string txHash, without a write', async () => {
    const r = await post({ txHash: TX })
    expect(r.status).to.equal(202)
    noStatusWrite()
  })
})
