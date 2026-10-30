/**
 * POST /api/upload/variant stores `<stem>_<width>.<ext>` next to an uploaded
 * image. The FE renders those names for avatars (96) and feed images (320,
 * 640, 2048). Base filenames are public, so the route must only take
 * variants from the token that uploaded the base.
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

const owners = new Map<string, number>()
const stored = new Set<string>()
const variants: { base: string; name: string }[] = []
let failOwnerWrite = false

const stubs: Record<string, unknown> = {
  '../../../src/api/util/uploadQuota': {
    reserveUpload: async (_kind: string, _tokenId: number, bytes: number) => ({ ok: true, used: bytes, quota: 0 }),
    refundReservation: async () => {},
    rememberUploadOwner: async (filenames: string[], tokenId: number) => {
      if (failOwnerWrite) throw new Error('redis down')
      for (const f of filenames) owners.set(f, tokenId)
    },
    uploadOwnerOf: async (filename: string) => owners.get(filename) ?? null,
  },
  '../../../src/api/util/mediaStorage': {
    mediaStorage: () => ({
      put: async (kind: string, name: string) => {
        stored.add(`${kind}/${name}`)
        return `http://media.test/uploads/${kind}/${name}`
      },
      putVariant: async (base: string, name: string) => {
        variants.push({ base, name })
        return `http://media.test/uploads/images/${name}`
      },
      baseExists: async (kind: string, name: string) => stored.has(`${kind}/${name}`),
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

/** Upload a base image as {tokenId} through multipart POST /, the way the FE does. */
async function uploadBase(tokenId: number): Promise<string> {
  const res = await request(app).post('/api/upload').field('tokenId', String(tokenId))
    .attach('media', await png(32), { filename: 'a.png', contentType: 'image/png' })
  expect(res.status).to.equal(200)
  const url: string = res.body.urls[0]
  return url.slice(url.lastIndexOf('/') + 1)
}

async function postVariant(tokenId: number, baseFilename: string) {
  return request(app).post('/api/upload/variant')
    .field('tokenId', String(tokenId)).field('baseFilename', baseFilename).field('width', '96')
    .attach('media', await png(16), { filename: 'v.png', contentType: 'image/png' })
}

describe('POST /api/upload/variant and the base image owner', () => {
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
    app.use('/api/upload', router)
  })

  after(() => {
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
  })

  beforeEach(() => {
    variants.length = 0
    owners.clear()
    stored.clear()
    failOwnerWrite = false
  })

  it('control: stores a variant from the token that uploaded the base', async () => {
    const base = await uploadBase(7)
    const res = await postVariant(7, base)
    expect(res.status).to.equal(200)
    expect(variants).to.deep.equal([{ base, name: base.replace('.', '_96.') }])
  })

  it("refuses a variant of another token's image", async () => {
    const base = await uploadBase(7)
    const res = await postVariant(8, base)
    expect(res.status).to.equal(403)
    expect(variants).to.have.length(0)
  })

  it('refuses a variant of an image with no owner record (older uploads)', async () => {
    stored.add('images/0badf00d.png')
    const res = await postVariant(7, '0badf00d.png')
    expect(res.status).to.equal(403)
    expect(variants).to.have.length(0)
  })

  it('a base upload still succeeds when the owner record cannot be written; its variants are refused', async () => {
    failOwnerWrite = true
    const base = await uploadBase(7)
    const res = await postVariant(7, base)
    expect(res.status).to.equal(403)
    expect(variants).to.have.length(0)
  })
})
