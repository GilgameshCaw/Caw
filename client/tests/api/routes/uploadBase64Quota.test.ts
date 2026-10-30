/**
 * POST /api/upload/image and /images (base64 JSON) store post images just like
 * the multipart POST /api/upload, but they never called reserveUpload, and
 * they accepted 10MB per image (multipart caps images at 1MB) with no limit on
 * how many images one request carries. So the 200MB/day per-token post quota
 * in uploadQuota.ts didn't apply to them.
 *
 * The real router runs through supertest, with sharp. uploadQuota (Redis),
 * mediaStorage and the auth middleware (Prisma + session store) are replaced
 * in require.cache before upload.ts loads, so nothing connects anywhere.
 */

import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'

type Call = { kind: string; tokenId: number; bytes: number }
const reserves: Call[] = []
const refunds: Call[] = []
const puts: { kind: string; name: string; bytes: number }[] = []
let quotaLeft = Infinity

const stubs: Record<string, unknown> = {
  '../../../src/api/util/uploadQuota': {
    reserveUpload: async (kind: string, tokenId: number, bytes: number) => {
      reserves.push({ kind, tokenId, bytes })
      if (bytes > quotaLeft) return { ok: false, used: 0, quota: 0, remaining: quotaLeft }
      quotaLeft -= bytes
      return { ok: true, used: bytes, quota: 0 }
    },
    refundReservation: async (kind: string, tokenId: number, bytes: number) => {
      refunds.push({ kind, tokenId, bytes })
    },
  },
  '../../../src/api/util/mediaStorage': {
    mediaStorage: () => ({
      put: async (kind: string, name: string, buf: Buffer) => {
        puts.push({ kind, name, bytes: buf.length })
        return `http://media.test/${kind}/${name}`
      },
    }),
  },
  '../../../src/api/middleware/auth': {
    requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}

const saved = new Map<string, NodeJS.Module | undefined>()
const uploadPath = require.resolve('../../../src/api/routes/upload')
let app: express.Express

const png = (w: number) =>
  sharp({ create: { width: w, height: w, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer()
const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`
// A PNG signature followed by junk passes looksLikeImage but not sharp.
const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

async function noisyPng(w: number) {
  // xorshift32: incompressible enough that the PNG stays far above 1MB.
  const raw = Buffer.alloc(w * w * 3)
  let x = 2463534242
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    raw[i] = x & 0xff
  }
  return sharp(raw, { raw: { width: w, height: w, channels: 3 } }).png().toBuffer()
}

describe('base64 upload routes and the daily post quota', () => {
  before(() => {
    for (const [rel, exports] of Object.entries(stubs)) {
      const p = require.resolve(rel)
      saved.set(p, require.cache[p])
      require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module
    }
    saved.set(uploadPath, require.cache[uploadPath])
    delete require.cache[uploadPath]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const router = require('../../../src/api/routes/upload').default
    app = express()
    app.use(express.json({ limit: '50mb' }))
    app.use('/api/upload', router)
  })

  after(() => {
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
  })

  beforeEach(() => {
    reserves.length = 0
    refunds.length = 0
    puts.length = 0
    quotaLeft = Infinity
  })

  it('control: multipart POST / reserves against the post quota', async () => {
    const img = await png(16)
    const res = await request(app).post('/api/upload').field('tokenId', '7').attach('media', img, { filename: 'a.png', contentType: 'image/png' })
    expect(res.status).to.equal(200)
    expect(reserves).to.deep.equal([{ kind: 'post', tokenId: 7, bytes: img.length }])
  })

  it('POST /image reserves the decoded bytes against the post quota', async () => {
    const img = await png(16)
    const res = await request(app).post('/api/upload/image').send({ tokenId: 7, image: dataUrl(img) })
    expect(res.status).to.equal(200)
    expect(reserves).to.deep.equal([{ kind: 'post', tokenId: 7, bytes: img.length }])
    expect(puts).to.have.length(1)
  })

  it('POST /images reserves the whole request once', async () => {
    const a = await png(16)
    const b = await png(24)
    const res = await request(app).post('/api/upload/images').send({ tokenId: '7', images: [dataUrl(a), dataUrl(b), 'not a data url'] })
    expect(res.status).to.equal(200)
    expect(res.body.urls).to.have.length(2)
    expect(reserves).to.deep.equal([{ kind: 'post', tokenId: 7, bytes: a.length + b.length }])
  })

  it('POST /images over the quota answers 429 and stores nothing', async () => {
    const img = await png(16)
    quotaLeft = img.length * 2
    const res = await request(app).post('/api/upload/images').send({ tokenId: 7, images: [dataUrl(img), dataUrl(img), dataUrl(img)] })
    expect(res.status).to.equal(429)
    expect(puts).to.have.length(0)
  })

  it('POST /image over the 1MB image cap answers 413, like multipart', async () => {
    const big = await noisyPng(1200)
    expect(big.length).to.be.greaterThan(1024 * 1024)
    const res = await request(app).post('/api/upload/image').send({ tokenId: 7, image: dataUrl(big) })
    expect(res.status).to.equal(413)
    expect(reserves).to.have.length(0)
    expect(puts).to.have.length(0)
  })

  it('POST /images refuses more than 10 images', async () => {
    const img = dataUrl(await png(8))
    const res = await request(app).post('/api/upload/images').send({ tokenId: 7, images: Array(11).fill(img) })
    expect(res.status).to.equal(400)
    expect(puts).to.have.length(0)
  })

  it('POST /image refunds the reservation when sharp rejects the image', async () => {
    const res = await request(app).post('/api/upload/image').send({ tokenId: 7, image: dataUrl(junk) })
    expect(res.status).to.equal(400)
    expect(reserves).to.deep.equal([{ kind: 'post', tokenId: 7, bytes: junk.length }])
    expect(refunds).to.deep.equal(reserves)
    expect(puts).to.have.length(0)
  })

  it('POST /images with a malformed last image stores none of the others', async () => {
    const a = await png(16)
    const b = await png(24)
    const res = await request(app).post('/api/upload/images').send({ tokenId: 7, images: [dataUrl(a), dataUrl(b), dataUrl(junk)] })
    expect(res.status).to.equal(400)
    expect(reserves).to.deep.equal([{ kind: 'post', tokenId: 7, bytes: a.length + b.length + junk.length }])
    expect(refunds).to.deep.equal(reserves)
    expect(puts).to.have.length(0)
  })

  it('multipart POST / with a malformed image stores none of the others', async () => {
    const img = await png(16)
    const res = await request(app).post('/api/upload').field('tokenId', '7')
      .attach('media', img, { filename: 'a.png', contentType: 'image/png' })
      .attach('media', junk, { filename: 'b.png', contentType: 'image/png' })
    expect(res.status).to.not.equal(200)
    // The other file's put would land after the response, so give it time.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(refunds).to.deep.equal(reserves)
    expect(puts).to.have.length(0)
  })
})
