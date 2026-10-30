/**
 * Orphan media GC.
 *
 * A hide marks every upload URL in the hidden post's imageData, and an avatar
 * or cover change marks the old URL. Seven days later the sweep deleted the
 * file without checking anything. Nothing records who uploaded a file, and
 * post image URLs come from the post text, so hiding a post that pasted
 * someone else's image URL (or using their image as an avatar, then changing
 * it) deleted that person's live file. The sweep now skips files that are
 * still referenced.
 *
 * A hide also marked only the base file, so the 320/640/2048 variants the FE
 * uploads next to a feed image stayed public forever, and avatar variants were
 * always marked as .webp even for a .jpg/.png/.gif base.
 *
 * A Redis error while dropping one mark must not end the sweep: the keys
 * after it are still processed, and the mark stays for the next sweep.
 *
 * ioredis, mediaStorage and prisma are put in require.cache before
 * orphanedMedia.ts loads, so nothing connects to Redis, a database or storage.
 */

import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

// ─── In-memory stand-ins ────────────────────────────────────────────────────

const zset = new Map<string, number>()
let zremFailsFor: string | null = null
class FakeRedis {
  status = 'ready'
  on() { return this }
  async zadd(_k: string, score: number, member: string) { zset.set(member, score); return 1 }
  async zrangebyscore(_k: string, min: number, max: number, _l: string, off: number, n: number) {
    return [...zset.entries()].filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1]).map(([m]) => m).slice(off, off + n)
  }
  async zrem(_k: string, member: string) {
    if (member === zremFailsFor) throw new Error('redis zrem failed')
    return zset.delete(member) ? 1 : 0
  }
  async zcard() { return zset.size }
}

const deleted: string[] = []
const storage = {
  bucketKeyFor: (kind: string, filename: string) => `node.example/${kind}/${filename}`,
  delete: async (kind: string, filename: string) => { deleted.push(`${kind}/${filename}`) },
}

type Row = Record<string, unknown>
const db: Record<string, Row[]> = {}
let dbDown = false

// Just the where shapes orphanedMedia.ts uses: contains, not, in, OR.
function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Record<string, any>[]).some(w => matches(row, w))
    const v = row[field]
    if (cond && typeof cond === 'object') {
      if ('contains' in cond) return typeof v === 'string' && v.includes(cond.contains)
      if ('not' in cond) return v !== cond.not
      if ('in' in cond) return cond.in.includes(v)
    }
    return v === cond
  })
}
const model = (name: string) => ({
  findFirst: async ({ where }: { where: Record<string, any> }) => {
    if (dbDown) throw new Error('db down')
    return (db[name] ?? []).find(r => matches(r, where)) ?? null
  },
})
const prisma = {
  caw: model('caw'),
  user: model('user'),
  scheduledCaw: model('scheduledCaw'),
  conversation: model('conversation'),
  // SELECT 1 FROM "Poll" WHERE strpos(array_to_string("optionImages", ' '), $1) > 0
  $queryRaw: async (_s: TemplateStringsArray, needle: string) =>
    (db.poll ?? []).filter(p => (p.optionImages as string[]).join(' ').includes(needle)).map(() => ({ '?column?': 1 })),
}

const stubs: Record<string, unknown> = {
  ioredis: { __esModule: true, default: FakeRedis },
  '../../src/api/util/mediaStorage': { mediaStorage: () => storage },
  '../../src/prismaClient': { prisma },
}
// If the tree has a shared Redis client module, swap that too, in case
// orphanedMedia.ts uses it and another test already loaded the real one.
try {
  require.resolve('../../src/lib/redisClient')
  stubs['../../src/lib/redisClient'] = { redis: new FakeRedis() }
} catch { /* no shared client module */ }

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ALICE_IMG = 'https://node.example/uploads/images/a1b2c3d4.webp'
const imageData = (...urls: string[]) => `urls:${urls.join('|||')}`

const realNow = Date.now
const pastGrace = () => { const t = realNow() + 8 * 24 * 3600 * 1000; Date.now = () => t }

let om: typeof import('../../src/api/util/orphanedMedia')
const saved = new Map<string, NodeJS.Module | undefined>()
const omPath = require.resolve('../../src/api/util/orphanedMedia')

describe('orphan media GC', () => {
  before(() => {
    for (const [rel, exports] of Object.entries(stubs)) {
      const p = require.resolve(rel)
      saved.set(p, require.cache[p])
      require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module
    }
    saved.set(omPath, require.cache[omPath])
    delete require.cache[omPath]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    om = require('../../src/api/util/orphanedMedia')
  })

  after(() => {
    Date.now = realNow
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
  })

  beforeEach(() => {
    Date.now = realNow
    zset.clear()
    deleted.length = 0
    for (const k of Object.keys(db)) delete db[k]
    dbDown = false
    zremFailsFor = null
  })

  describe('sweep keeps files that are still referenced', () => {
    it("hiding a post that pasted another user's image doesn't delete it", async () => {
      db.caw = [
        { id: 1, userId: 1, status: 'SUCCESS', imageData: imageData(ALICE_IMG), content: '' },
        { id: 2, userId: 2, status: 'HIDDEN', imageData: imageData(ALICE_IMG), content: '' },
      ]
      await om.markOrphansInImageData(imageData(ALICE_IMG)) // user 2 hid post 2
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal([])
      expect(zset.size, 'marks dropped').to.equal(0)
    })

    it('control: with no other reference the file and its variants are deleted', async () => {
      db.caw = [{ id: 2, userId: 2, status: 'HIDDEN', imageData: imageData(ALICE_IMG), content: '' }]
      await om.markOrphansInImageData(imageData(ALICE_IMG))
      pastGrace()
      await om.sweep()
      expect(deleted).to.include('images/a1b2c3d4.webp')
      expect(deleted).to.include('images/a1b2c3d4_2048.webp')
    })

    it("changing an avatar that was another user's image doesn't delete it", async () => {
      const url = 'https://node.example/uploads/images/b2c3d4e5.jpg'
      db.user = [{ id: 1, avatarUrl: url, coverPhotoUrl: null }]
      await om.markOrphanWithVariants(url) // user 2 replaced an avatar that pointed at user 1's file
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal([])
    })

    it('a pending scheduled post, a group avatar or a poll option image keeps the file', async () => {
      db.scheduledCaw = [{ id: 1, status: 'pending', imageData: imageData('https://x/uploads/images/c3d4e5f6.webp'), content: '' }]
      db.conversation = [{ id: 1, avatarUrl: 'https://x/uploads/images/d4e5f6a7.webp' }]
      db.poll = [{ id: 1, optionImages: ['https://x/uploads/images/e5f6a7b8.webp'] }]
      for (const f of ['c3d4e5f6', 'd4e5f6a7', 'e5f6a7b8']) await om.markOrphan(`https://node.example/uploads/images/${f}.webp`)
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal([])
    })

    it('control: a published scheduled post does not keep the file', async () => {
      db.scheduledCaw = [{ id: 1, status: 'published', imageData: imageData('https://x/uploads/images/c3d4e5f6.webp'), content: '' }]
      await om.markOrphan('https://node.example/uploads/images/c3d4e5f6.webp')
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal(['images/c3d4e5f6.webp'])
    })

    it('a variant is kept while its base is referenced', async () => {
      db.caw = [{ id: 1, status: 'SUCCESS', imageData: imageData(ALICE_IMG), content: '' }]
      await om.markOrphan('https://node.example/uploads/images/a1b2c3d4_640.webp')
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal([])
    })

    it('a failed reference check leaves the mark for the next sweep', async () => {
      await om.markOrphan(ALICE_IMG)
      dbDown = true
      pastGrace()
      await om.sweep()
      expect(deleted).to.deep.equal([])
      expect(zset.size).to.equal(1)
    })
  })

  describe('a failed ZREM does not stop the sweep', () => {
    const KEPT = 'node.example/images/a1b2c3d4.webp'
    const LOOSE = 'https://node.example/uploads/images/b2c3d4e5.webp'

    it('a kept file whose mark cannot be dropped: the next key is still processed', async () => {
      db.caw = [{ id: 1, status: 'SUCCESS', imageData: imageData(ALICE_IMG), content: '' }]
      await om.markOrphan(ALICE_IMG)
      await om.markOrphan(LOOSE)
      zset.set(KEPT, zset.get(KEPT)! - 1) // the failing key comes first
      zremFailsFor = KEPT
      pastGrace()
      const r = await om.sweep()
      expect(deleted).to.deep.equal(['images/b2c3d4e5.webp'])
      expect(r).to.include({ deleted: 1, failed: 1, kept: 0 })
      expect([...zset.keys()], 'mark left for the next sweep').to.deep.equal([KEPT])
    })

    it('an unparseable key whose mark cannot be dropped: the next key is still processed', async () => {
      zset.set('not-a-media-key', 0)
      zremFailsFor = 'not-a-media-key'
      await om.markOrphan(LOOSE)
      pastGrace()
      const r = await om.sweep()
      expect(deleted).to.deep.equal(['images/b2c3d4e5.webp'])
      expect(r).to.include({ deleted: 1, failed: 1, skipped: 0 })
    })
  })

  describe('variant marks', () => {
    it('a hide marks the feed variants the FE uploads (320, 640, 2048)', async () => {
      await om.markOrphansInImageData(imageData(ALICE_IMG))
      const keys = [...zset.keys()]
      for (const w of [320, 640, 2048]) expect(keys).to.include(`node.example/images/a1b2c3d4_${w}.webp`)
    })

    it("an avatar's variants keep the base's extension", async () => {
      await om.markOrphanWithVariants('https://node.example/uploads/images/f6a7b8c9.jpg')
      expect([...zset.keys()]).to.include('node.example/images/f6a7b8c9_96.jpg')
    })
  })
})
