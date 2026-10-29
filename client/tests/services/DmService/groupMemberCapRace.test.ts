// A group holds at most 10 members, also when several people are added at
// the same moment (invite links, or the owner adding from two places).
//
// Integration-style: runs the real groupService against a real database.
// DATABASE_URL must point at a disposable test database (the name has to
// contain "caw_test_"); otherwise the suite is skipped. Never run it against
// a live install. Use a connection_limit of at least 30 in the URL: every
// redeem holds one connection for its transaction and uses another one for
// the block check, so a small pool stalls when several redeems overlap.

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import { prisma } from '../../../src/prismaClient'
import groupService, { GroupServiceError } from '../../../src/services/DmService/groupService'

const ON_TEST_DB = (process.env.DATABASE_URL || '').includes('caw_test_')

const OWNER = 92000
const USER_COUNT = 40
const ALL_IDS = Array.from({ length: USER_COUNT + 1 }, (_, i) => OWNER + i)
const MAX_MEMBERS = 10

async function reset() {
  await prisma.groupInvite.deleteMany({ where: { createdByUserId: { in: ALL_IDS } } })
  await prisma.conversation.deleteMany({ where: { creatorId: OWNER } })
  await prisma.dmIdentity.deleteMany({ where: { userId: { in: ALL_IDS } } })
  await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
}

async function seedUsers() {
  for (const id of ALL_IDS) {
    await prisma.user.create({ data: { id, tokenId: id, username: `caprace${id}` } })
    await prisma.dmIdentity.create({ data: { userId: id, walletAddress: `0x${id}`, publicKey: `pk${id}` } })
  }
}

// A group of `size` active members: the owner plus users 92001 .. 92000 + size - 1.
async function groupOfSize(size: number) {
  const members = Array.from({ length: size - 1 }, (_, i) => OWNER + 1 + i)
  const conv = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      creatorId: OWNER,
      participants: { create: [{ userId: OWNER, role: 'OWNER' }, ...members.map(userId => ({ userId, role: 'MEMBER' as const }))] },
    },
  })
  return conv.id
}

// Users that are not in any group yet, 92021 and up.
const outsider = (i: number) => OWNER + 21 + i

const mint = (conversationId: string, maxUses: number) =>
  groupService.mintInvite({ conversationId, actorUserId: OWNER, expiresAt: new Date(Date.now() + 3600e3), maxUses })

type Outcome = { ok: true } | { ok: false; code: string }
async function settle(calls: Promise<unknown>[]): Promise<Outcome[]> {
  return (await Promise.allSettled(calls)).map(s => s.status === 'fulfilled'
    ? { ok: true as const }
    : { ok: false as const, code: s.reason instanceof GroupServiceError ? s.reason.code : String(s.reason) })
}
const successes = (o: Outcome[]) => o.filter(x => x.ok).length
const refusedAsFull = (o: Outcome[]) => o.filter(x => !x.ok).every(x => !x.ok && x.code === 'GROUP_FULL')
const activeMembers = (conversationId: string) =>
  prisma.conversationParticipant.count({ where: { conversationId, leftAt: null } })

const redeem = (token: string, userId: number) => groupService.redeemInvite({ token, actorUserId: userId })
const add = (conversationId: string, ...targetUserIds: number[]) =>
  groupService.addMembers({ conversationId, actorUserId: OWNER, targetUserIds })

describe('groupService / member cap under concurrency', () => {
  before(async function () {
    if (!ON_TEST_DB) return this.skip()
    await reset()
    await seedUsers()
  })
  after(async () => {
    if (!ON_TEST_DB) return
    await reset()
    await prisma.$disconnect()
  })

  it('the last seat goes to one of several people redeeming at once (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const conv = await groupOfSize(MAX_MEMBERS - 1)
      const inv = await mint(conv, 20)
      const out = await settle([0, 1, 2, 3, 4, 5].map(i => redeem(inv.token, outsider(i))))
      expect(successes(out), `round ${round}`).to.equal(1)
      expect(refusedAsFull(out), `round ${round}`).to.equal(true)
      expect(await activeMembers(conv), `round ${round}`).to.equal(MAX_MEMBERS)
    }
  })

  it('three seats left, six people redeeming at once: three get in', async () => {
    const conv = await groupOfSize(MAX_MEMBERS - 3)
    const inv = await mint(conv, 20)
    const out = await settle([0, 1, 2, 3, 4, 5].map(i => redeem(inv.token, outsider(i))))
    expect(successes(out)).to.equal(3)
    expect(refusedAsFull(out)).to.equal(true)
    expect(await activeMembers(conv)).to.equal(MAX_MEMBERS)
  })

  it('the owner adding two people at once fills one seat (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const conv = await groupOfSize(MAX_MEMBERS - 1)
      const out = await settle([add(conv, outsider(0)), add(conv, outsider(1))])
      expect(successes(out), `round ${round}`).to.equal(1)
      expect(refusedAsFull(out), `round ${round}`).to.equal(true)
      expect(await activeMembers(conv), `round ${round}`).to.equal(MAX_MEMBERS)
    }
  })

  it('two adds of two people each, two seats left: one add goes through', async () => {
    const conv = await groupOfSize(MAX_MEMBERS - 2)
    const out = await settle([add(conv, outsider(0), outsider(1)), add(conv, outsider(2), outsider(3))])
    expect(successes(out)).to.equal(1)
    expect(refusedAsFull(out)).to.equal(true)
    expect(await activeMembers(conv)).to.equal(MAX_MEMBERS)
  })

  it('an add and a redeem at the same time share the last seat (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const conv = await groupOfSize(MAX_MEMBERS - 1)
      const inv = await mint(conv, 5)
      const out = await settle([add(conv, outsider(0)), redeem(inv.token, outsider(1))])
      expect(successes(out), `round ${round}`).to.equal(1)
      expect(refusedAsFull(out), `round ${round}`).to.equal(true)
      expect(await activeMembers(conv), `round ${round}`).to.equal(MAX_MEMBERS)
    }
  })

  it('someone who left and comes back competes for the same seat', async () => {
    const conv = await groupOfSize(MAX_MEMBERS)
    const leaver = OWNER + 1
    await groupService.leaveGroup({ conversationId: conv, actorUserId: leaver })
    expect(await activeMembers(conv)).to.equal(MAX_MEMBERS - 1)
    const inv = await mint(conv, 5)
    const out = await settle([redeem(inv.token, leaver), add(conv, outsider(0))])
    expect(successes(out)).to.equal(1)
    expect(refusedAsFull(out)).to.equal(true)
    expect(await activeMembers(conv)).to.equal(MAX_MEMBERS)
  })

  it('adds, a leave and a removal at the same time never leave more than 10 members and raise no other error (15 rounds)', async () => {
    for (let round = 0; round < 15; round++) {
      const conv = await groupOfSize(MAX_MEMBERS - 1)
      const inv = await mint(conv, 20)
      const out = await settle([
        redeem(inv.token, outsider(0)),
        redeem(inv.token, outsider(1)),
        redeem(inv.token, outsider(2)),
        add(conv, outsider(3)),
        groupService.leaveGroup({ conversationId: conv, actorUserId: OWNER + 1 }),
        groupService.removeMember({ conversationId: conv, actorUserId: OWNER, targetUserId: OWNER + 2 }),
      ])
      // The leave and the removal go through; an add may be refused as full
      // (also when the count it saw still included someone who was leaving),
      // and nothing else may go wrong (no deadlock, no unique violation).
      expect(out[4], `round ${round}`).to.deep.equal({ ok: true })
      expect(out[5], `round ${round}`).to.deep.equal({ ok: true })
      expect(refusedAsFull(out), `round ${round}`).to.equal(true)
      expect(await activeMembers(conv), `round ${round}`).to.be.at.most(MAX_MEMBERS)
    }
  })

  it('a full group still refuses a single add or redeem', async () => {
    const conv = await groupOfSize(MAX_MEMBERS)
    const inv = await mint(conv, 5)
    expect(await settle([add(conv, outsider(0))])).to.deep.equal([{ ok: false, code: 'GROUP_FULL' }])
    expect(await settle([redeem(inv.token, outsider(1))])).to.deep.equal([{ ok: false, code: 'GROUP_FULL' }])
    expect(await activeMembers(conv)).to.equal(MAX_MEMBERS)
  })
})
