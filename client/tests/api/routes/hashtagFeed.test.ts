/**
 * GET /api/hashtags/:tag/caws is a post list like /api/caws, and has to treat the
 * viewer the same way:
 *
 *  - Viewer-specific state (liked, reposted, bookmarked) is only attached for a
 *    verified session. `x-user-id` on its own is a value the client can set to
 *    anything, so it must not unlock another user's state.
 *  - For a verified viewer the posts carry the same state as on the other lists.
 *    The route used to build its own `include`, without the fields `shapeCaw`
 *    reads, so a post the viewer had reposted or bookmarked showed neither, and
 *    the author's X badge was missing.
 *  - Posts by an author the viewer blocked are left out (as on /api/caws).
 *
 * The sessions are real ones in the test Redis (db 15, see isolatedEnv). The test
 * writes rows and goes through the real route, so it only runs against a database
 * whose name starts with "caw_test_" (a schema-only copy: pg_dump -s), and it skips
 * itself when another test file in the same run has already changed DATABASE_URL.
 *
 *   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_hashtagfeed' \
 *     npx mocha --import=tsx --exit tests/api/routes/hashtagFeed.test.ts
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990700
const author = { tokenId: BASE, username: 'hf_author' }
const viewer = { tokenId: BASE + 1, username: 'hf_viewer' }
const other = { tokenId: BASE + 2, username: 'hf_other' }
const blocked = { tokenId: BASE + 3, username: 'hf_blocked' }
const TOKENS = [author.tokenId, viewer.tokenId, other.tokenId, blocked.tokenId]
const addrOf = (tokenId: number) => '0x' + String(tokenId).padStart(40, '0')
const TAG = 'hashtagfeedtest'

;(HAS_TEST_DB ? describe : describe.skip)('GET /api/hashtags/:tag/caws treats the viewer like the other post lists', function () {
  this.timeout(30000)
  let app: express.Express
  let prisma: any
  let store: any
  let viewerToken = ''
  let otherToken = ''
  let mainId: number     // the author's post: liked, reposted and bookmarked by the viewer
  let olderId: number    // an older post by the author
  let blockedId: number  // a post by the user the viewer blocked
  let started = false

  async function wipe() {
    const users = { in: TOKENS }
    const cawIds = (await prisma.caw.findMany({ where: { userId: users }, select: { id: true } })).map((c: any) => c.id)
    await prisma.cawHashtag.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.hashtag.deleteMany({ where: { name: TAG } })
    await prisma.like.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.bookmark.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.block.deleteMany({ where: { blockerId: users } })
    await prisma.walletXLink.deleteMany({ where: { address: addrOf(author.tokenId) } })
    await prisma.caw.deleteMany({ where: { id: { in: cawIds }, originalCawId: { not: null } } })
    await prisma.caw.deleteMany({ where: { id: { in: cawIds } } })
    await prisma.user.deleteMany({ where: { tokenId: users } })
  }

  before(async function () {
    // Another test file in the same run can change DATABASE_URL after this file
    // was loaded, and then isolatedEnv refuses to load the app: skip, don't fail.
    try {
      await import('../../helpers/isolatedEnv')
    } catch {
      return this.skip()
    }
    ;({ prisma } = await import('../../../src/prismaClient'))
    store = await import('../../../src/api/sessionStore')
    // The session store keeps one Redis connection per process. When an earlier
    // test file in the same run has already closed it, createSession throws
    // instead of returning: skip, and run this file on its own.
    try {
      ;({ token: viewerToken } = await store.createSession())
      await store.addAuthorization(viewerToken, addrOf(viewer.tokenId), [viewer.tokenId])
      ;({ token: otherToken } = await store.createSession())
      await store.addAuthorization(otherToken, addrOf(other.tokenId), [other.tokenId])
    } catch {
      return this.skip()
    }
    const hashtagsRouter = (await import('../../../src/api/routes/hashtags')).default
    app = express()
    app.use(express.json())
    app.use('/api/hashtags', hashtagsRouter)

    await wipe()
    for (const u of [author, viewer, other, blocked]) {
      await prisma.user.create({ data: { id: u.tokenId, tokenId: u.tokenId, username: u.username, address: addrOf(u.tokenId) } })
    }

    const tag = await prisma.hashtag.create({ data: { name: TAG, usageCount: 3 } })
    const t0 = Date.now()
    const older = await prisma.caw.create({ data: { userId: author.tokenId, content: `older #${TAG}`, action: 'CAW', cawonce: 1, status: 'SUCCESS', createdAt: new Date(t0 - 3000) } })
    const main = await prisma.caw.create({ data: { userId: author.tokenId, content: `main #${TAG}`, action: 'CAW', cawonce: 2, status: 'SUCCESS', createdAt: new Date(t0 - 2000) } })
    const blockedPost = await prisma.caw.create({ data: { userId: blocked.tokenId, content: `blocked #${TAG}`, action: 'CAW', cawonce: 1, status: 'SUCCESS', createdAt: new Date(t0 - 1000) } })
    olderId = older.id; mainId = main.id; blockedId = blockedPost.id
    await prisma.cawHashtag.createMany({ data: [older, main, blockedPost].map(c => ({ cawId: c.id, hashtagId: tag.id })) })

    // the viewer's own state on the main post
    await prisma.like.create({ data: { userId: viewer.tokenId, cawId: main.id, action: 'LIKE', pending: false } })
    await prisma.bookmark.create({ data: { userId: viewer.tokenId, cawId: main.id } })
    await prisma.caw.create({ data: { userId: viewer.tokenId, content: '', action: 'RECAW', cawonce: 1, originalCawId: main.id, status: 'SUCCESS' } })
    await prisma.block.create({ data: { blockerId: viewer.tokenId, blockedId: blocked.tokenId } })
    await prisma.walletXLink.create({ data: { address: addrOf(author.tokenId), xUserId: 'x-hf-author', xHandle: 'hf_author_x' } })
    started = true
  })

  after(async () => {
    if (!started) { if (prisma) await prisma.$disconnect(); return }   // skipped in before(); nothing was written
    for (const t of TOKENS) await store.pruneTokenIdFromAllSessions(t)
    await store.deleteSession(viewerToken)
    await store.deleteSession(otherToken)
    await wipe()
    await prisma.$disconnect()
  })

  const list = (query = '') => request(app).get(`/api/hashtags/${TAG}/caws${query}`)
  const asViewer = (r: request.Test) => r.set('x-user-id', String(viewer.tokenId))
  const main = (body: any) => body.items.find((i: any) => i.id === String(mainId))
  const ids = (body: any) => body.items.map((i: any) => i.id)
  // isBookmarked is absent, not false, when no viewer state is attached
  const state = (item: any) => ({ hasLiked: item.hasLiked, hasRecawed: item.hasRecawed, isBookmarked: Boolean(item.isBookmarked) })
  const NONE = { hasLiked: false, hasRecawed: false, isBookmarked: false }
  const ALL = { hasLiked: true, hasRecawed: true, isBookmarked: true }

  describe('viewer state', () => {
    it('is not attached without a header', async () => {
      const res = await list().expect(200)
      expect(state(main(res.body))).to.deep.equal(NONE)
    })

    it('is not attached on x-user-id alone', async () => {
      const res = await asViewer(list()).expect(200)
      expect(state(main(res.body))).to.deep.equal(NONE)
    })

    it('is not attached when another user\'s session claims the viewer id', async () => {
      const res = await asViewer(list()).set('x-session-token', otherToken).expect(200)
      expect(state(main(res.body))).to.deep.equal(NONE)
    })

    it('is attached for the verified session: liked, reposted and bookmarked', async () => {
      const res = await asViewer(list()).set('x-session-token', viewerToken).expect(200)
      expect(state(main(res.body))).to.deep.equal(ALL)
    })

    it('is not attached to the posts the viewer did not touch', async () => {
      const res = await asViewer(list()).set('x-session-token', viewerToken).expect(200)
      const older = res.body.items.find((i: any) => i.id === String(olderId))
      expect(state(older)).to.deep.equal(NONE)
    })
  })

  describe('X badge', () => {
    it('is on the author\'s posts, with or without a viewer', async () => {
      const anonymous = await list().expect(200)
      expect(main(anonymous.body).user.xHandle).to.equal('hf_author_x')
      const verified = await asViewer(list()).set('x-session-token', viewerToken).expect(200)
      expect(main(verified.body).user.xHandle).to.equal('hf_author_x')
    })
  })

  describe('blocked authors', () => {
    it('are left out for the user who blocked them', async () => {
      const res = await asViewer(list()).expect(200)
      expect(ids(res.body)).to.not.include(String(blockedId))
      expect(ids(res.body)).to.include(String(mainId))
    })

    it('are listed for everyone else', async () => {
      const anonymous = await list().expect(200)
      expect(ids(anonymous.body)).to.include(String(blockedId))
      const asOther = await list().set('x-user-id', String(other.tokenId)).set('x-session-token', otherToken).expect(200)
      expect(ids(asOther.body)).to.include(String(blockedId))
    })
  })

  describe('paging', () => {
    it('walks the whole list one post at a time, newest first, then ends', async () => {
      const seen: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 5; i++) {
        const res = await asViewer(list(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).set('x-session-token', viewerToken).expect(200)
        seen.push(...ids(res.body))
        cursor = res.body.nextCursor
        if (!cursor) break
      }
      expect(seen).to.deep.equal([String(mainId), String(olderId)])
      expect(cursor).to.equal(undefined)
    })
  })
})
