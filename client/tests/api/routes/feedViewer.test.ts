/**
 * Viewer-specific state on the /api/caws read routes (feed, post page, by-ids)
 * is only attached for a verified session. `x-user-id` on its own is a value the
 * client can set to anything, so it must not unlock another user's FAILED post,
 * their own PENDING/FAILED posts in the feed, or their liked / bookmarked /
 * poll-vote state.
 *
 * The sessions are real ones in the test Redis (db 15, see isolatedEnv).
 * Writes rows and goes through the real routes, so it needs a throwaway
 * database. It SKIPS unless DATABASE_URL points at a caw_test_* database.
 * Example (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_feedviewer \
 *   npx mocha --import=tsx --exit tests/api/routes/feedViewer.test.ts
 */
import '../../helpers/isolatedEnv'
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990400
const author = { tokenId: BASE, username: 'fv_author' }
const other = { tokenId: BASE + 1, username: 'fv_other' }
const TOKENS = [author.tokenId, other.tokenId]
const addrOf = (tokenId: number) => '0x' + String(tokenId).padStart(40, '0')

;(HAS_TEST_DB ? describe : describe.skip)('/api/caws only attaches viewer state for a verified session', function () {
  this.timeout(30000)
  let app: express.Express
  let prisma: any
  let store: any
  let authorToken = ''
  let otherToken = ''
  let failedId: number
  let pollId: number

  async function wipe() {
    const cawIds = (await prisma.caw.findMany({ where: { userId: { in: TOKENS } }, select: { id: true } })).map((c: any) => c.id)
    await prisma.tip.deleteMany({ where: { OR: [{ cawId: { in: cawIds } }, { senderId: { in: TOKENS } }] } })
    await prisma.reply.deleteMany({ where: { OR: [{ cawId: { in: cawIds } }, { replyCawId: { in: cawIds } }] } })
    await prisma.like.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.bookmark.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.poll.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.caw.deleteMany({ where: { id: { in: cawIds }, originalCawId: { not: null } } })
    await prisma.caw.deleteMany({ where: { id: { in: cawIds } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: TOKENS } } })
  }

  before(async () => {
    ;({ prisma } = await import('../../../src/prismaClient'))
    const cawsRouter = (await import('../../../src/api/routes/caws')).default
    app = express()
    app.use(express.json())
    app.use('/api/caws', cawsRouter)

    await wipe()
    for (const u of [author, other]) {
      await prisma.user.create({ data: { id: u.tokenId, tokenId: u.tokenId, username: u.username, address: addrOf(u.tokenId) } })
    }
    store = await import('../../../src/api/sessionStore')
    ;({ token: authorToken } = await store.createSession())
    await store.addAuthorization(authorToken, addrOf(author.tokenId), [author.tokenId])
    ;({ token: otherToken } = await store.createSession())
    await store.addAuthorization(otherToken, addrOf(other.tokenId), [other.tokenId])

    // the author's FAILED post: creator-only
    failedId = (await prisma.caw.create({ data: { userId: author.tokenId, content: 'fv failed post', action: 'CAW', cawonce: 1, status: 'FAILED' } })).id
    // the author's public post with a poll, liked, bookmarked and voted on by the author
    const poll = await prisma.caw.create({ data: { userId: author.tokenId, content: 'fv poll\n::poll:Yes:No::', action: 'CAW', cawonce: 2 } })
    pollId = poll.id
    const pollRow = await prisma.poll.create({ data: { cawId: poll.id, options: ['Yes', 'No'], optionImages: [], totalVotes: 1 } })
    await prisma.vote.create({ data: { pollId: pollRow.id, voterId: author.tokenId, optionIndex: 0, cawonce: 1 } })
    await prisma.like.create({ data: { userId: author.tokenId, cawId: poll.id, action: 'LIKE', pending: false } })
    await prisma.bookmark.create({ data: { userId: author.tokenId, cawId: poll.id } })
    await prisma.caw.create({ data: { userId: author.tokenId, content: '', action: 'RECAW', cawonce: 3, originalCawId: poll.id } })
    const reply = await prisma.caw.create({ data: { userId: author.tokenId, content: 'fv reply', action: 'CAW', cawonce: 4, originalCawId: poll.id } })
    await prisma.reply.create({ data: { userId: author.tokenId, cawId: poll.id, replyCawId: reply.id } })
    await prisma.tip.create({ data: { senderId: author.tokenId, recipientId: other.tokenId, amount: 5, cawId: poll.id, cawonce: 1 } })
  })

  after(async () => {
    if (store) {
      await store.pruneTokenIdFromAllSessions(author.tokenId)
      await store.pruneTokenIdFromAllSessions(other.tokenId)
      await store.deleteSession(authorToken)
      await store.deleteSession(otherToken)
    }
    if (prisma) { await wipe(); await prisma.$disconnect() }
  })

  const asAuthor = (r: request.Test) => r.set('x-user-id', String(author.tokenId))
  const feedIds = (body: any) => body.items.map((i: any) => i.id)

  describe('GET /api/caws/:id on a FAILED post', () => {
    it('is hidden without a header', async () => {
      await request(app).get(`/api/caws/${failedId}`).expect(404)
    })
    it('is hidden when only x-user-id names the author', async () => {
      await asAuthor(request(app).get(`/api/caws/${failedId}`)).expect(404)
    })
    it('is hidden when another user\'s session claims the author id', async () => {
      await asAuthor(request(app).get(`/api/caws/${failedId}`)).set('x-session-token', otherToken).expect(404)
    })
    it('is hidden from another user who sends their own id', async () => {
      await request(app).get(`/api/caws/${failedId}`).set('x-user-id', String(other.tokenId)).set('x-session-token', otherToken).expect(404)
    })
    it('is shown to the author with a verified session', async () => {
      const res = await asAuthor(request(app).get(`/api/caws/${failedId}`)).set('x-session-token', authorToken).expect(200)
      expect(res.body.caw.id).to.equal(String(failedId))
    })
  })

  describe('GET /api/caws (feed)', () => {
    it('does not add the claimed user\'s FAILED post on x-user-id alone', async () => {
      const res = await asAuthor(request(app).get('/api/caws?limit=50')).expect(200)
      const ids = feedIds(res.body)
      expect(ids).to.include(String(pollId))
      expect(ids).to.not.include(String(failedId))
    })
    it('adds it for the verified session', async () => {
      const res = await asAuthor(request(app).get('/api/caws?limit=50')).set('x-session-token', authorToken).expect(200)
      expect(feedIds(res.body)).to.include(String(failedId))
    })
    it('does not add it for another user\'s session claiming the author id', async () => {
      const res = await asAuthor(request(app).get('/api/caws?limit=50')).set('x-session-token', otherToken).expect(200)
      expect(feedIds(res.body)).to.not.include(String(failedId))
    })
  })

  describe('GET /api/caws?filter=following', () => {
    it('is empty, not the public feed, without a verified viewer', async () => {
      const none = await request(app).get('/api/caws?filter=following&limit=50').expect(200)
      expect(none.body.items).to.deep.equal([])
      const header = await asAuthor(request(app).get('/api/caws?filter=following&limit=50')).expect(200)
      expect(header.body.items).to.deep.equal([])
      const claimed = await asAuthor(request(app).get('/api/caws?filter=following&limit=50')).set('x-session-token', otherToken).expect(200)
      expect(claimed.body.items).to.deep.equal([])
    })
    it('still works for the verified session (own posts are included)', async () => {
      const res = await asAuthor(request(app).get('/api/caws?filter=following&limit=50')).set('x-session-token', authorToken).expect(200)
      expect(feedIds(res.body)).to.include(String(pollId))
    })
  })

  describe('liked / bookmarked / poll vote state', () => {
    const find = (items: any[]) => items.find((i: any) => i.id === String(pollId))

    it('GET /api/caws/:id: absent on x-user-id alone, present for the verified session', async () => {
      const anon = await asAuthor(request(app).get(`/api/caws/${pollId}`)).expect(200)
      expect(anon.body.caw.hasLiked).to.equal(false)
      expect(anon.body.caw.isBookmarked ?? false).to.equal(false)
      expect(anon.body.caw.poll.userVote ?? null).to.equal(null)
      expect([anon.body.caw.hasRecawed, anon.body.caw.hasReplied, anon.body.caw.hasTipped]).to.deep.equal([false, false, false])
      // everything that is not viewer-specific is still there
      expect(anon.body.caw.poll.options).to.deep.equal(['Yes', 'No'])

      const authed = await asAuthor(request(app).get(`/api/caws/${pollId}`)).set('x-session-token', authorToken).expect(200)
      expect(authed.body.caw.hasLiked).to.equal(true)
      expect(authed.body.caw.isBookmarked).to.equal(true)
      expect(authed.body.caw.poll.userVote).to.deep.include({ optionIndex: 0 })
      expect([authed.body.caw.hasRecawed, authed.body.caw.hasReplied, authed.body.caw.hasTipped]).to.deep.equal([true, true, true])
    })

    it('POST /api/caws/by-ids: same', async () => {
      const anon = await asAuthor(request(app).post('/api/caws/by-ids')).send({ ids: [pollId] }).expect(200)
      const a = find(anon.body.items)
      expect(a.hasLiked).to.equal(false)
      expect(a.poll.userVote ?? null).to.equal(null)
      expect([a.hasRecawed, a.hasReplied, a.hasTipped]).to.deep.equal([false, false, false])

      const authed = await asAuthor(request(app).post('/api/caws/by-ids')).set('x-session-token', authorToken).send({ ids: [pollId] }).expect(200)
      const b = find(authed.body.items)
      expect(b.hasLiked).to.equal(true)
      expect(b.poll.userVote).to.deep.include({ optionIndex: 0 })
      expect([b.hasRecawed, b.hasReplied, b.hasTipped]).to.deep.equal([true, true, true])
    })

    it('GET /api/caws: same', async () => {
      const anon = await asAuthor(request(app).get('/api/caws?limit=50')).expect(200)
      expect(find(anon.body.items).hasLiked).to.equal(false)
      expect([find(anon.body.items).hasRecawed, find(anon.body.items).hasReplied, find(anon.body.items).hasTipped]).to.deep.equal([false, false, false])
      const authed = await asAuthor(request(app).get('/api/caws?limit=50')).set('x-session-token', authorToken).expect(200)
      expect(find(authed.body.items).hasLiked).to.equal(true)
      expect([find(authed.body.items).hasRecawed, find(authed.body.items).hasReplied, find(authed.body.items).hasTipped]).to.deep.equal([true, true, true])
    })
  })
})
