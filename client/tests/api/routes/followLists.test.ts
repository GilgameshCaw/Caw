/**
 * Followers / following lists and the "following" timeline must only include
 * confirmed follows (action = FOLLOW and status = SUCCESS).
 *
 * A follow that failed on-chain stays in the table as status = FAILED, and an
 * unconfirmed one is PENDING; neither may be listed, and their authors' posts
 * must not appear in the follower's "following" timeline.
 *
 * This test writes rows and goes through the real HTTP routes, so it needs a
 * throwaway database. It SKIPS (rather than failing the whole mocha run at
 * import time) unless DATABASE_URL points at a caw_test_* database. Example
 * (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_followlists \
 *   npx mocha --import=tsx --exit tests/api/routes/followLists.test.ts
 *
 * The app is imported lazily inside `before`, after ../../helpers/isolatedEnv
 * has pointed Elasticsearch/Redis at unreachable/throwaway targets — importing
 * the API app connects to both at import time, so none of that may happen at
 * module load on a developer's machine running the plain suite.
 *
 * The schema has to exist in that database (the project's usual schema setup).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import type { Server } from 'http'
import type { AddressInfo } from 'net'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const BASE = 990100

const CASES = [
  { name: 'FOLLOW + SUCCESS',   action: 'FOLLOW',   status: 'SUCCESS', visible: true  },
  { name: 'FOLLOW + PENDING',   action: 'FOLLOW',   status: 'PENDING', visible: false },
  { name: 'FOLLOW + FAILED',    action: 'FOLLOW',   status: 'FAILED',  visible: false },
  { name: 'UNFOLLOW + SUCCESS', action: 'UNFOLLOW', status: 'SUCCESS', visible: false },
  { name: 'UNFOLLOW + PENDING', action: 'UNFOLLOW', status: 'PENDING', visible: false },
] as const

const viewer = { tokenId: BASE, username: 'fl_test_viewer' }
const others = CASES.map((c, i) => ({ ...c, tokenId: BASE + 1 + i, username: `fl_test_u${i + 1}` }))
const ALL_IDS = [viewer.tokenId, ...others.map(o => o.tokenId)]

;(HAS_TEST_DB ? describe : describe.skip)('follow lists only include confirmed follows', function () {
  this.timeout(30000)

  // Bound in `before` via dynamic import (see header).
  let prisma: typeof import('../../../src/prismaClient').prisma
  let createApp: typeof import('../../../src/api/server').createApp

  let server: Server | undefined
  let baseUrl = ''
  let safe = false
  let following: any
  let followers: any
  let timeline: any

  async function getJson(path: string, headers: Record<string, string> = {}) {
    const res = await (globalThis as any).fetch(baseUrl + path, { headers })
    expect(res.status, `GET ${path} -> ${res.status}`).to.equal(200)
    return res.json()
  }

  async function cleanup() {
    await prisma.caw.deleteMany({ where: { userId: { in: ALL_IDS } } })
    await prisma.follow.deleteMany({
      where: { OR: [{ followerId: { in: ALL_IDS } }, { followingId: { in: ALL_IDS } }] },
    })
    await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
  }

  before(async () => {
    await import('../../helpers/isolatedEnv')
    ;({ prisma } = await import('../../../src/prismaClient'))
    ;({ createApp } = await import('../../../src/api/server'))
    const [{ current_database }] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`
    if (!/^caw_test_/.test(current_database)) {
      throw new Error(`refusing to run against database "${current_database}" (expected a caw_test_* database)`)
    }
    safe = true
    await cleanup()

    await prisma.user.createMany({
      data: [viewer, ...others].map(u => ({ id: u.tokenId, tokenId: u.tokenId, username: u.username })),
    })
    // viewer follows each other user, and each other user follows the viewer,
    // in the state under test (so /following, /followers and the timeline all
    // see the same five states)
    await prisma.follow.createMany({
      data: others.flatMap(o => [
        { followerId: viewer.tokenId, followingId: o.tokenId, action: o.action, status: o.status },
        { followerId: o.tokenId, followingId: viewer.tokenId, action: o.action, status: o.status },
      ]),
    })
    await prisma.caw.createMany({
      data: others.map(o => ({
        userId: o.tokenId,
        content: `post by ${o.username}`,
        action: 'CAW' as const,
        cawonce: 1,
        status: 'SUCCESS' as const,
      })),
    })

    await new Promise<void>(resolve => {
      server = createApp().listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

    following = await getJson(`/api/users/${viewer.username}/following`)
    followers = await getJson(`/api/users/${viewer.username}/followers`)
    timeline = await getJson('/api/caws?filter=following', { 'x-user-id': String(viewer.tokenId) })
  })

  after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (safe) await cleanup()
  })

  for (const o of others) {
    const verb = o.visible ? 'lists' : 'omits'
    it(`/following ${verb} ${o.name}`, () => {
      expect(following.items.map((u: any) => u.tokenId).includes(o.tokenId)).to.equal(o.visible)
    })
    it(`/followers ${verb} ${o.name}`, () => {
      expect(followers.items.map((u: any) => u.tokenId).includes(o.tokenId)).to.equal(o.visible)
    })
    it(`following timeline ${o.visible ? 'shows' : 'hides'} posts of ${o.name}`, () => {
      expect(timeline.items.map((c: any) => c.user?.tokenId).includes(o.tokenId)).to.equal(o.visible)
    })
  }
})
