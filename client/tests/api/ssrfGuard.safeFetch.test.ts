// safeFetch: isSafePublicUrl only looks at one URL, and plain fetch()
// follows 3xx by itself, so a page that passes the check can 302 the
// server somewhere private. safeFetch follows redirects by hand and
// re-checks each hop.
//
// Both servers listen on 127.0.0.1, which isSafePublicUrl rejects. The
// "trusted" server stands in for an allowed origin via trustInitial; the
// "secret" server stands in for a private address a redirect points at.

import { expect } from 'chai'
import http from 'http'
import type { AddressInfo } from 'net'
import { safeFetch } from '../../src/api/util/ssrfGuard'

function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

describe('ssrfGuard safeFetch', () => {
  let secretHits = 0
  let secret: { server: http.Server; origin: string }
  let trusted: { server: http.Server; origin: string }

  before(async () => {
    secret = await listen((_req, res) => { secretHits++; res.end('secret') })
    trusted = await listen((req, res) => {
      if (req.url === '/to-secret') { res.statusCode = 302; res.setHeader('location', `${secret.origin}/x`); return res.end() }
      if (req.url === '/to-metadata') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); return res.end() }
      if (req.url === '/to-same') { res.statusCode = 301; res.setHeader('location', '/ok'); return res.end() }
      if (req.url === '/no-location') { res.statusCode = 302; return res.end() }
      if (req.url === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); return res.end() }
      res.end('ok')
    })
  })
  after(() => { secret.server.close(); trusted.server.close() })
  beforeEach(() => { secretHits = 0 })

  it('control: plain fetch() follows the redirect to the other origin', async () => {
    const res = await fetch(`${trusted.origin}/to-secret`)
    expect(await res.text()).to.eq('secret')
    expect(secretHits).to.eq(1)
  })

  it('does not follow a redirect to an address that fails the check', async () => {
    const res = await safeFetch(`${trusted.origin}/to-secret`, {}, { trustInitial: true })
    expect(res).to.eq(null)
    expect(secretHits).to.eq(0)
  })

  it('rejects a redirect to link-local metadata without connecting', async () => {
    expect(await safeFetch(`${trusted.origin}/to-metadata`, {}, { trustInitial: true })).to.eq(null)
  })

  it('follows a redirect that stays on the trusted origin', async () => {
    const res = await safeFetch(`${trusted.origin}/to-same`, {}, { trustInitial: true })
    expect(res).to.not.eq(null)
    expect(res!.status).to.eq(200)
    expect(await res!.text()).to.eq('ok')
  })

  it('checks the first URL when it is not trusted', async () => {
    expect(await safeFetch(`${secret.origin}/x`)).to.eq(null)
    expect(secretHits).to.eq(0)
  })

  it('returns null for a redirect without Location and for a redirect loop', async () => {
    expect(await safeFetch(`${trusted.origin}/no-location`, {}, { trustInitial: true })).to.eq(null)
    expect(await safeFetch(`${trusted.origin}/loop`, {}, { trustInitial: true })).to.eq(null)
  })
})
