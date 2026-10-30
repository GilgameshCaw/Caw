/**
 * /api/ai-proxy caps its JSON body at 8 KB (routes/ai-proxy.ts). The router
 * mounted that parser on its own routes, but server.ts mounts the global 50 MB
 * express.json() before the router, and a body parser skips a body another
 * parser has already read. So the 8 KB cap never applied; up to 50 MB was read.
 *
 * server.ts can't be loaded here (it imports every router), so the test reads
 * its express.json() mounts from the source, in order, and builds an app with
 * them in front of the real ai-proxy router. Every request leaves out apiKey,
 * so the handler stops at its own check and nothing reaches a provider.
 */

import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import aiProxyRouter from '../../../src/api/routes/ai-proxy'

type Mount = { path: string | null; limit: string }

/** The express.json() mounts in server.ts, in source order. */
function serverJsonMounts(): Mount[] {
  const src = readFileSync(path.join(__dirname, '../../../src/api/server.ts'), 'utf8')
  const re = /app\.use\(\s*(?:'([^']+)'\s*,\s*)?express\.json\(\{\s*limit:\s*'([^']+)'\s*\}\)\s*\)/g
  return [...src.matchAll(re)].map(m => ({ path: m[1] ?? null, limit: m[2] }))
}

function appWith(mounts: Mount[]): express.Express {
  const app = express()
  app.set('env', 'test') // express's default error handler then answers 413 without printing the stack
  for (const m of mounts) {
    if (m.path) app.use(m.path, express.json({ limit: m.limit }))
    else app.use(express.json({ limit: m.limit }))
  }
  app.use('/api/ai-proxy', aiProxyRouter)
  return app
}

// Same-host Origin, so originGate lets the request through.
const post = (app: express.Express, body: object) =>
  request(app).post('/api/ai-proxy/openai/image').set('Origin', 'http://127.0.0.1').send(body)

const big = { prompt: 'x', pad: 'a'.repeat(9 * 1024) }

describe('/api/ai-proxy body limit', () => {
  let mounts: Mount[]

  before(() => {
    mounts = serverJsonMounts()
  })

  it('control: server.ts has the global 50mb parser', () => {
    expect(mounts).to.deep.include({ path: null, limit: '50mb' })
  })

  it('rejects a 9 KB body with the parsers mounted as in server.ts', async () => {
    const res = await post(appWith(mounts), big)
    expect(res.status).to.equal(413)
  })

  it('control: a small body reaches the handler', async () => {
    const res = await post(appWith(mounts), { prompt: 'a cat' })
    expect(res.status).to.equal(400)
    expect(res.body).to.deep.equal({ error: { kind: 'auth', message: 'Missing API key.' } })
  })

  it('control: behind only the 50mb parser, the router-level cap does not apply', async () => {
    const res = await post(appWith([{ path: null, limit: '50mb' }]), big)
    expect(res.status).to.equal(400)
    expect(res.body.error.kind).to.equal('auth')
  })
})
