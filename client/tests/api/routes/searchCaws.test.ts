/**
 * GET /api/search (type=caws and type=all) must return posts shaped like the
 * other post lists (/api/caws, /api/bookmarks): author display name and avatar,
 * poll, viewer state (liked / bookmarked), and quote vs reply.
 *
 * Viewer-specific state (liked / bookmarked / poll vote) is only attached for a
 * verified session; x-user-id on its own is not trusted. The session is a real
 * one in the test Redis (db 15, see isolatedEnv).
 *
 * Writes rows and goes through the real route, so it needs a throwaway
 * database. It SKIPS unless DATABASE_URL points at a caw_test_* database.
 * Example (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_searchcaws \
 *   npx mocha --import=tsx --exit tests/api/routes/searchCaws.test.ts
 *
 * The Elasticsearch path is exercised by stubbing the service (no ES is
 * reachable in the test environment); the Prisma path runs for real.
 */
import { describe, it, before, after, afterEach } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990300
const viewer = { tokenId: BASE, username: 'sc_viewer' }
const authorA = { tokenId: BASE + 1, username: 'sc_author_a', displayName: 'Author A', avatarUrl: 'https://example.test/a.png', defaultAvatarId: 7 }
const authorB = { tokenId: BASE + 2, username: 'sc_author_b', displayName: 'Author B', avatarUrl: null, defaultAvatarId: 9 }
const TOKENS = [viewer.tokenId, authorA.tokenId, authorB.tokenId]

;(HAS_TEST_DB ? describe : describe.skip)('GET /api/search shapes posts like the other post lists', function () {
  this.timeout(30000)
  let app: express.Express
  let prisma: any
  let es: any
  let store: any
  let sessionToken = ''
  const addrOf = (tokenId: number) => '0x' + String(tokenId).padStart(40, '0')
  let pollCawId: number
  let replyCawId: number
  let quoteCawId: number
  let blockedCawId: number
  let hiddenReplyCawId: number
  let hiddenQuoteCawId: number
  const originals: Record<string, any> = {}

  async function wipe() {
    const cawIds = (await prisma.caw.findMany({ where: { userId: { in: TOKENS } }, select: { id: true } })).map((c: any) => c.id)
    await prisma.reply.deleteMany({ where: { OR: [{ cawId: { in: cawIds } }, { replyCawId: { in: cawIds } }] } })
    await prisma.like.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.bookmark.deleteMany({ where: { cawId: { in: cawIds } } })
    await prisma.block.deleteMany({ where: { blockerId: { in: TOKENS } } })
    await prisma.poll.deleteMany({ where: { cawId: { in: cawIds } } })
    // quotes/replies point at their parent: delete children first
    await prisma.caw.deleteMany({ where: { id: { in: cawIds }, originalCawId: { not: null } } })
    await prisma.caw.deleteMany({ where: { id: { in: cawIds } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: TOKENS } } })
  }

  before(async () => {
    // Must run before anything that starts Elasticsearch/Redis clients; lazy so the plain suite just skips.
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    ;({ elasticsearchService: es } = await import('../../../src/services/ElasticsearchService'))
    const searchRouter = (await import('../../../src/api/routes/search')).default
    app = express()
    app.use('/api/search', searchRouter)
    originals.isAvailable = es.isAvailable
    originals.search = es.search

    await wipe()
    for (const u of [viewer, authorA, authorB]) {
      await prisma.user.create({ data: { id: u.tokenId, tokenId: u.tokenId, username: u.username, address: '0x' + String(u.tokenId).padStart(40, '0'), ...(('displayName' in u) ? { displayName: (u as any).displayName, avatarUrl: (u as any).avatarUrl, defaultAvatarId: (u as any).defaultAvatarId } : {}) } })
    }
    store = await import('../../../src/api/sessionStore')
    ;({ token: sessionToken } = await store.createSession())
    await store.addAuthorization(sessionToken, addrOf(viewer.tokenId), [viewer.tokenId])
    // A: a post with a poll and a video, liked, bookmarked and voted on by the viewer
    const poll = await prisma.caw.create({ data: { userId: authorA.tokenId, content: 'scfind poll\n::poll:Yes:No::', action: 'CAW', cawonce: 1, hasVideo: true, videoData: 'vid-1' } })
    pollCawId = poll.id
    const pollRow = await prisma.poll.create({ data: { cawId: poll.id, options: ['Yes', 'No'], optionImages: [], totalVotes: 1 } })
    await prisma.vote.create({ data: { pollId: pollRow.id, voterId: viewer.tokenId, optionIndex: 0, cawonce: 1 } })
    await prisma.like.create({ data: { userId: viewer.tokenId, cawId: poll.id, action: 'LIKE', pending: false } })
    await prisma.bookmark.create({ data: { userId: viewer.tokenId, cawId: poll.id } })
    // B replies to A's post (CAW with a parent + a Reply row)
    const reply = await prisma.caw.create({ data: { userId: authorB.tokenId, content: 'scfind reply', action: 'CAW', cawonce: 1, originalCawId: poll.id } })
    replyCawId = reply.id
    await prisma.reply.create({ data: { userId: authorB.tokenId, cawId: poll.id, replyCawId: reply.id } })
    // B quotes A's post (RECAW with text)
    const quote = await prisma.caw.create({ data: { userId: authorB.tokenId, content: 'scfind quote', action: 'RECAW', cawonce: 2, originalCawId: poll.id } })
    quoteCawId = quote.id
    // a post by B that the viewer will block
    const blocked = await prisma.caw.create({ data: { userId: authorB.tokenId, content: 'scfind from blocked author', action: 'CAW', cawonce: 3 } })
    blockedCawId = blocked.id
    // a HIDDEN post with text, an image and a poll, replied to and quoted by B
    const hidden = await prisma.caw.create({ data: { userId: authorA.tokenId, content: 'hidden parent body', action: 'CAW', cawonce: 4, status: 'HIDDEN', hasImage: true, imageData: 'img-hidden-secret' } })
    await prisma.poll.create({ data: { cawId: hidden.id, options: ['Hidden yes', 'Hidden no'], optionImages: [], totalVotes: 0 } })
    const hReply = await prisma.caw.create({ data: { userId: authorB.tokenId, content: 'scfind hidden reply', action: 'CAW', cawonce: 4, originalCawId: hidden.id } })
    hiddenReplyCawId = hReply.id
    await prisma.reply.create({ data: { userId: authorB.tokenId, cawId: hidden.id, replyCawId: hReply.id } })
    const hQuote = await prisma.caw.create({ data: { userId: authorB.tokenId, content: 'scfind hidden quote', action: 'RECAW', cawonce: 5, originalCawId: hidden.id } })
    hiddenQuoteCawId = hQuote.id
  })

  afterEach(() => {
    es.isAvailable = originals.isAvailable
    es.search = originals.search
  })

  after(async () => {
    if (store) {
      await store.pruneTokenIdFromAllSessions(viewer.tokenId)
      await store.deleteSession(sessionToken)
    }
    if (prisma) { await wipe(); await prisma.$disconnect() }
  })

  const byId = (items: any[], id: number) => items.find((i: any) => i.id === String(id))

  it('Prisma path (type=all): author name/avatar, poll, viewer state, quote vs reply, video', async () => {
    es.isAvailable = () => false
    const res = await request(app).get('/api/search?q=scfind&type=all')
      .set('x-user-id', String(viewer.tokenId)).set('x-session-token', sessionToken).expect(200)
    const items = res.body.caws
    const p = byId(items, pollCawId)
    expect(p, 'poll post').to.exist
    expect(p.user).to.include({ displayName: 'Author A', avatarUrl: 'https://example.test/a.png', defaultAvatarId: 7, tokenId: authorA.tokenId })
    expect(p.poll.options).to.deep.equal(['Yes', 'No'])
    expect(p.hasLiked).to.equal(true)
    expect(p.isBookmarked).to.equal(true)
    expect(p.poll.userVote).to.deep.include({ optionIndex: 0 })
    expect(p.videoData).to.equal('vid-1')
    expect(p.hasVideo).to.equal(true)

    const q = byId(items, quoteCawId)
    expect(q.isQuote, 'quote is a quote').to.equal(true)
    expect(q.parent.user.displayName).to.equal('Author A')
    expect(q.parent.poll.options).to.deep.equal(['Yes', 'No'])

    const r = byId(items, replyCawId)
    expect(r.isQuote, 'reply is not a quote').to.equal(false)
    expect(r.parent.id).to.equal(String(pollCawId))
  })

  it('without x-user-id: poll and names are present, viewer state is empty', async () => {
    es.isAvailable = () => false
    const res = await request(app).get('/api/search?q=scfind&type=caws').expect(200)
    const p = byId(res.body.items, pollCawId)
    expect(p.user.displayName).to.equal('Author A')
    expect(p.poll.options).to.deep.equal(['Yes', 'No'])
    expect(p.hasLiked).to.equal(false)
  })

  it('Elasticsearch path (type=caws): same shape, ES relevance order kept', async () => {
    es.isAvailable = () => true
    es.search = async () => ({ hits: { hits: [{ _id: String(quoteCawId) }, { _id: String(pollCawId) }, { _id: String(replyCawId) }] } })
    const res = await request(app).get('/api/search?q=scfind&type=caws')
      .set('x-user-id', String(viewer.tokenId)).set('x-session-token', sessionToken).expect(200)
    expect(res.body.items.map((i: any) => i.id)).to.deep.equal([String(quoteCawId), String(pollCawId), String(replyCawId)])
    const p = byId(res.body.items, pollCawId)
    expect(p.user.displayName).to.equal('Author A')
    expect(p.poll.options).to.deep.equal(['Yes', 'No'])
    expect(p.hasLiked).to.equal(true)
    expect(byId(res.body.items, quoteCawId).isQuote).to.equal(true)
    expect(byId(res.body.items, replyCawId).isQuote).to.equal(false)
  })

  const expectMaskedHiddenParent = (c: any) => {
    expect(c, 'result').to.exist
    for (const parent of [c.parent, c.originalCaw]) {
      expect(parent, 'embedded parent').to.exist
      expect(parent.status).to.equal('HIDDEN')
      expect(parent.user.displayName, 'author kept').to.equal('Author A')
      expect(parent.content, 'content').to.equal('')
      expect(parent.imageData ?? null, 'imageData').to.equal(null)
      expect(parent.hasImage ?? false, 'hasImage').to.equal(false)
      expect(parent.poll ?? null, 'poll').to.equal(null)
    }
  }

  it('Prisma path: a HIDDEN parent of a reply or quote keeps id/author/status but not body, image or poll', async () => {
    es.isAvailable = () => false
    const res = await request(app).get('/api/search?q=scfind&type=caws')
      .set('x-user-id', String(viewer.tokenId)).set('x-session-token', sessionToken).expect(200)
    expectMaskedHiddenParent(byId(res.body.items, hiddenReplyCawId))
    expectMaskedHiddenParent(byId(res.body.items, hiddenQuoteCawId))
    expect(JSON.stringify(res.body)).to.not.include('hidden parent body')
    expect(JSON.stringify(res.body)).to.not.include('img-hidden-secret')
    expect(JSON.stringify(res.body)).to.not.include('Hidden yes')
  })

  it('Elasticsearch path: a HIDDEN parent is masked the same way', async () => {
    es.isAvailable = () => true
    es.search = async () => ({ hits: { hits: [{ _id: String(hiddenReplyCawId) }, { _id: String(hiddenQuoteCawId) }] } })
    const res = await request(app).get('/api/search?q=scfind&type=caws')
      .set('x-user-id', String(viewer.tokenId)).set('x-session-token', sessionToken).expect(200)
    expectMaskedHiddenParent(byId(res.body.items, hiddenReplyCawId))
    expectMaskedHiddenParent(byId(res.body.items, hiddenQuoteCawId))
    expect(JSON.stringify(res.body)).to.not.include('img-hidden-secret')
  })

  it('a visible parent is unchanged (content, image and poll still present)', async () => {
    es.isAvailable = () => false
    const res = await request(app).get('/api/search?q=scfind&type=caws').expect(200)
    const q = byId(res.body.items, quoteCawId)
    expect(q.parent.content).to.include('scfind poll')
    expect(q.parent.poll.options).to.deep.equal(['Yes', 'No'])
  })

  const expectNoViewerState = (p: any) => {
    expect(p.hasLiked, 'hasLiked').to.equal(false)
    expect(p.isBookmarked ?? false, 'isBookmarked').to.equal(false)
    expect(p.poll.userVote ?? null, 'poll.userVote').to.equal(null)
    // everything that is not viewer-specific is still there
    expect(p.user.displayName).to.equal('Author A')
    expect(p.poll.options).to.deep.equal(['Yes', 'No'])
  }

  it('x-user-id alone (no session) does not expose that user\'s liked / bookmarked / voted state', async () => {
    es.isAvailable = () => false
    const res = await request(app).get('/api/search?q=scfind&type=caws').set('x-user-id', String(viewer.tokenId)).expect(200)
    expectNoViewerState(byId(res.body.items, pollCawId))
  })

  it('another user\'s session does not unlock the claimed user\'s state', async () => {
    es.isAvailable = () => false
    const { token } = await store.createSession()
    await store.addAuthorization(token, addrOf(authorB.tokenId), [authorB.tokenId])
    try {
      const res = await request(app).get('/api/search?q=scfind&type=caws')
        .set('x-user-id', String(viewer.tokenId)).set('x-session-token', token).expect(200)
      expectNoViewerState(byId(res.body.items, pollCawId))
    } finally {
      await store.pruneTokenIdFromAllSessions(authorB.tokenId)
      await store.deleteSession(token)
    }
  })

  it('blocked authors are still filtered out (type=caws; still keyed on the header, unchanged)', async () => {
    es.isAvailable = () => false
    await prisma.block.create({ data: { blockerId: viewer.tokenId, blockedId: authorB.tokenId } })
    try {
      const res = await request(app).get('/api/search?q=scfind&type=caws').set('x-user-id', String(viewer.tokenId)).expect(200)
      const ids = res.body.items.map((i: any) => i.id)
      expect(ids).to.include(String(pollCawId))
      expect(ids).to.not.include(String(blockedCawId))
      expect(ids).to.not.include(String(quoteCawId))
    } finally {
      await prisma.block.deleteMany({ where: { blockerId: viewer.tokenId } })
    }
  })
})
