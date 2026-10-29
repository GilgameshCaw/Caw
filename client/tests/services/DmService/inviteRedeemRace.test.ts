// redeemInvite must not hand out more uses than an invite has, even when
// several people press the link at the same moment.
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

const OWNER = 91000
const USERS_FROM = 91001 // contenders are 91001 .. 91000 + USER_COUNT
const USER_COUNT = 40
const ALL_IDS = Array.from({ length: USER_COUNT + 1 }, (_, i) => OWNER + i)

async function reset() {
  await prisma.groupInvite.deleteMany({ where: { createdByUserId: { in: ALL_IDS } } })
  await prisma.conversation.deleteMany({ where: { creatorId: OWNER } })
  await prisma.dmIdentity.deleteMany({ where: { userId: { in: ALL_IDS } } })
  await prisma.user.deleteMany({ where: { tokenId: { in: ALL_IDS } } })
}

async function seedUsers(withIdentity: (id: number) => boolean = () => true) {
  for (const id of ALL_IDS) {
    await prisma.user.create({ data: { id, tokenId: id, username: `invrace${id}` } })
    if (withIdentity(id)) {
      await prisma.dmIdentity.create({ data: { userId: id, walletAddress: `0x${id}`, publicKey: `pk${id}` } })
    }
  }
}

async function newGroup() {
  const conv = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      creatorId: OWNER,
      participants: { create: [{ userId: OWNER, role: 'OWNER' }] },
    },
  })
  return conv.id
}

async function mint(conversationId: string, maxUses: number) {
  return groupService.mintInvite({
    conversationId,
    actorUserId: OWNER,
    expiresAt: new Date(Date.now() + 3600e3),
    maxUses,
  })
}

type Outcome = { ok: true } | { ok: false; code: string }
async function redeemAll(token: string, userIds: number[]): Promise<Outcome[]> {
  const settled = await Promise.allSettled(userIds.map(u => groupService.redeemInvite({ token, actorUserId: u })))
  return settled.map(s => s.status === 'fulfilled'
    ? { ok: true as const }
    : { ok: false as const, code: s.reason instanceof GroupServiceError ? s.reason.code : String(s.reason) })
}

const successes = (o: Outcome[]) => o.filter(x => x.ok).length
const useCount = async (inviteId: string) => (await prisma.groupInvite.findUniqueOrThrow({ where: { id: inviteId } })).useCount
const activeMembers = (conversationId: string) =>
  prisma.conversationParticipant.count({ where: { conversationId, leftAt: null } })

describe('groupService.redeemInvite / use count under concurrency', () => {
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

  it('a 1-use invite pressed by several people at once admits exactly one (20 rounds)', async () => {
    for (let round = 0; round < 20; round++) {
      const conv = await newGroup()
      const inv = await mint(conv, 1)
      const out = await redeemAll(inv.token, [91001, 91002, 91003, 91004, 91005, 91006])
      expect(successes(out), `round ${round}`).to.equal(1)
      expect(out.filter(x => !x.ok).every(x => !x.ok && x.code === 'INVITE_EXHAUSTED'), `round ${round}`).to.equal(true)
      expect(await useCount(inv.id), `round ${round}`).to.equal(1)
      expect(await activeMembers(conv), `round ${round}`).to.equal(2)
    }
  })

  it('a 3-use invite pressed by 8 people at once admits exactly three', async () => {
    const conv = await newGroup()
    const inv = await mint(conv, 3)
    const out = await redeemAll(inv.token, [91001, 91002, 91003, 91004, 91005, 91006, 91007, 91008])
    expect(successes(out)).to.equal(3)
    expect(await useCount(inv.id)).to.equal(3)
    expect(await activeMembers(conv)).to.equal(4)
  })

  it('the same person pressing twice at once uses the invite once', async () => {
    for (let round = 0; round < 10; round++) {
      const conv = await newGroup()
      const inv = await mint(conv, 5)
      const out = await redeemAll(inv.token, [91001, 91001])
      expect(successes(out), `round ${round}`).to.equal(1)
      expect(out.find(x => !x.ok), `round ${round}`).to.deep.equal({ ok: false, code: 'ALREADY_MEMBER' })
      expect(await useCount(inv.id), `round ${round}`).to.equal(1)
    }
  })

  it('a refused redeem does not use up the invite', async () => {
    const conv = await newGroup()
    const inv = await mint(conv, 2)
    await prisma.dmIdentity.update({ where: { userId: 91003 }, data: { publicKey: '' } })

    expect(await redeemAll(inv.token, [91001])).to.deep.equal([{ ok: true }])
    expect(await redeemAll(inv.token, [91001])).to.deep.equal([{ ok: false, code: 'ALREADY_MEMBER' }])
    expect(await redeemAll(inv.token, [91003])).to.deep.equal([{ ok: false, code: 'NO_DM_IDENTITY' }])
    expect(await useCount(inv.id)).to.equal(1)

    await prisma.dmIdentity.update({ where: { userId: 91003 }, data: { publicKey: 'pk91003' } })
    expect(await redeemAll(inv.token, [91002])).to.deep.equal([{ ok: true }])
    expect(await useCount(inv.id)).to.equal(2)
  })

  it('a redeem that fails and rolls back does not take the use from someone pressing at the same time', async () => {
    for (let round = 0; round < 10; round++) {
      const conv = await newGroup()
      const inv = await mint(conv, 1)
      await prisma.conversationParticipant.create({ data: { conversationId: conv, userId: 91001 } })
      // 91001 is already in: that redeem fails, whichever of the two claims first.
      const out = await redeemAll(inv.token, [91001, 91002])
      expect(out[1], `round ${round}`).to.deep.equal({ ok: true })
      expect(out[0].ok, `round ${round}`).to.equal(false)
      expect(await useCount(inv.id), `round ${round}`).to.equal(1)
    }
  })

  it('a full group refuses without using up the invite', async () => {
    const conv = await newGroup()
    const inv = await mint(conv, 5)
    await prisma.conversationParticipant.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({ conversationId: conv, userId: USERS_FROM + i })),
    })
    expect(await activeMembers(conv)).to.equal(10)
    expect(await redeemAll(inv.token, [91020])).to.deep.equal([{ ok: false, code: 'GROUP_FULL' }])
    expect(await useCount(inv.id)).to.equal(0)
  })

  it('keeps the specific error for a revoked, expired or used-up invite', async () => {
    const conv = await newGroup()

    const revoked = await mint(conv, 3)
    await groupService.revokeInvite({ conversationId: conv, actorUserId: OWNER, inviteId: revoked.id })
    expect(await redeemAll(revoked.token, [91030])).to.deep.equal([{ ok: false, code: 'INVITE_REVOKED' }])

    const expired = await mint(conv, 3)
    await prisma.groupInvite.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await redeemAll(expired.token, [91030])).to.deep.equal([{ ok: false, code: 'INVITE_EXPIRED' }])

    const usedUp = await mint(conv, 1)
    expect(await redeemAll(usedUp.token, [91031])).to.deep.equal([{ ok: true }])
    expect(await redeemAll(usedUp.token, [91030])).to.deep.equal([{ ok: false, code: 'INVITE_EXHAUSTED' }])
    expect(await useCount(usedUp.id)).to.equal(1)
  })
})
