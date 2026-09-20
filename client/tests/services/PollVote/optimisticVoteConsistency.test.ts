// Consistency of poll totalVotes between the API's optimistic write and the
// indexer (handleVoteAction), the way they really run one after the other on the
// node that took the request. Mirror nodes only run the indexer half.
//
// The database tests write rows, so they only run against a throwaway database
// whose name starts with "caw_test_" (a schema-only copy: pg_dump -s). Anywhere
// else they are skipped.
//
//   createdb caw_test_pollvote   # then load the schema only
//   NETWORK_ID=1 CLIENT_ID=1 DATABASE_URL='postgresql://.../caw_test_pollvote' \
//     REDIS_URL=redis://127.0.0.1:1 ELASTICSEARCH_NODE=http://127.0.0.1:1 ES_INDEX_PREFIX=caw_test_pollvote \
//     npx mocha --import=tsx --exit tests/services/PollVote/optimisticVoteConsistency.test.ts
//
// Importing the action handlers creates a Redis client (orphanedMedia) and an
// Elasticsearch client (ElasticsearchService) at import time, and a reachable
// Elasticsearch would be filled from the database. The three variables above
// point both at an unused port (and a private index prefix) so this test never
// reaches a real Redis or Elasticsearch. Expect connection-refused log lines.

import { expect } from 'chai'

const dbName = (process.env.DATABASE_URL || '').split('?')[0].split('/').pop() || ''
const describeDb = dbName.startsWith('caw_test_') ? describe : describe.skip

const OWNER = 91001 // poll author
const VOTER = 91002
const MIRROR_VOTER = 91003 // same sequence, indexer only

let prisma: any
let handleVoteAction: (tx: any, action: any, rawAction: any, voterId: number) => Promise<void>
let writeOptimisticPollVote: (client: any, p: any) => Promise<void>
let NotificationService: any
let realCreateVoteNotification: any

async function loadModules(): Promise<void> {
  // The modules read their environment at import time.
  process.env.NETWORK_ID = process.env.NETWORK_ID || '1'
  process.env.CLIENT_ID = process.env.CLIENT_ID || '1'
  prisma = (await import('../../../src/prismaClient')).prisma
  handleVoteAction = (await import('../../../src/services/ActionProcessor/actionHandlers')).handleVoteAction
  writeOptimisticPollVote = (await import('../../../src/api/util/optimisticPollVote')).writeOptimisticPollVote
  NotificationService = (await import('../../../src/services/NotificationService')).NotificationService
}

async function resetFixtures(): Promise<void> {
  await prisma.caw.deleteMany({ where: { userId: OWNER } }) // cascades to Poll and Vote
  await prisma.user.deleteMany({ where: { id: { in: [OWNER, VOTER, MIRROR_VOTER] } } })
  for (const id of [OWNER, VOTER, MIRROR_VOTER]) {
    await prisma.user.create({ data: { id, tokenId: id, username: `pvtest${id}` } })
  }
}

/** A poll owned by OWNER. Each call uses its own cawonce so several polls can coexist. */
let nextCawonce = 1
async function createPoll(multiSelect: boolean): Promise<{ pollId: number; cawonce: number }> {
  const cawonce = nextCawonce++
  const caw = await prisma.caw.create({ data: { userId: OWNER, content: 'poll', action: 'CAW', cawonce } })
  const poll = await prisma.poll.create({ data: { cawId: caw.id, options: ['a', 'b', 'c'], multiSelect } })
  return { pollId: poll.id, cawonce }
}

type Poll = { pollId: number; cawonce: number }

/** The API's optimistic write (runs on the node that took the request). */
const api = (p: Poll, voterId: number, optionIndex: number | null, cawonce: number, multiSelect: boolean) =>
  writeOptimisticPollVote(prisma, { pollId: p.pollId, voterId, optionIndex, multiSelect, cawonce })

/** The indexer half: the vote action landing on chain. */
const confirm = (p: Poll, voterId: number, optionIndex: number | null, cawonce: number) =>
  prisma.$transaction(async (tx: any) => {
    await handleVoteAction(
      tx,
      { cawonce },
      { text: optionIndex === null ? 'vote:' : `vote:${optionIndex}`, receiverId: OWNER, receiverCawonce: p.cawonce },
      voterId,
    )
  })

async function state(p: Poll, voterId: number): Promise<{ total: number; rows: string[] }> {
  const poll = await prisma.poll.findUnique({ where: { id: p.pollId } })
  const votes = await prisma.vote.findMany({ where: { pollId: p.pollId, voterId } })
  return {
    total: poll.totalVotes,
    rows: votes.map((v: any) => `${v.optionIndex}:${v.pending ? 'pending' : 'confirmed'}`).sort(),
  }
}

describeDb('poll totalVotes: API optimistic write + indexer (disposable database)', () => {
  before(async () => {
    await loadModules()
    const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`
    if (!String(db).startsWith('caw_test_')) throw new Error(`refusing to run against database "${db}"`)
    // Keep the notification out of the test; it is not what is being checked.
    realCreateVoteNotification = NotificationService.createVoteNotification
    NotificationService.createVoteNotification = async () => {}
  })
  after(async () => {
    if (NotificationService && realCreateVoteNotification) NotificationService.createVoteNotification = realCreateVoteNotification
    if (prisma) await resetFixtures().catch(() => {})
  })
  beforeEach(resetFixtures)

  describe('unchanged behaviour (regression guards)', () => {
    it('single-select: first vote is pending, then confirmed and counted once', async () => {
      const p = await createPoll(false)
      await api(p, VOTER, 0, 10, false)
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: ['0:pending'] })
      await confirm(p, VOTER, 0, 10)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
    })

    it('single-select: changing the vote keeps the count at 1 and replaces the row', async () => {
      const p = await createPoll(false)
      await api(p, VOTER, 0, 10, false); await confirm(p, VOTER, 0, 10)
      await api(p, VOTER, 1, 11, false)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed', '1:pending'] })
      await confirm(p, VOTER, 1, 11)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['1:confirmed'] })
    })

    it('multi-select: toggle ON is confirmed and counted', async () => {
      const p = await createPoll(true)
      await api(p, VOTER, 0, 10, true)
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: ['0:pending'] })
      await confirm(p, VOTER, 0, 10)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
    })

    it('single-select: unvote removes the row and the count when it confirms', async () => {
      const p = await createPoll(false)
      await api(p, VOTER, 0, 10, false); await confirm(p, VOTER, 0, 10)
      await api(p, VOTER, null, 12, false)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] }) // known window
      await confirm(p, VOTER, null, 12)
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: [] })
    })

    it('multi-select: a toggle ON turned OFF before it confirms nets to zero', async () => {
      const p = await createPoll(true)
      await api(p, VOTER, 0, 10, true) // pending row
      await api(p, VOTER, 0, 11, true) // OFF: the pending row was never counted, so it can go
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: [] })
      await confirm(p, VOTER, 0, 10) // both actions still land on chain, in order
      await confirm(p, VOTER, 0, 11)
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: [] })
    })
  })

  describe('the same class of bug: the API must not touch a confirmed row', () => {
    it('multi-select toggle OFF of a confirmed vote: the row stays until the indexer removes it', async () => {
      const p = await createPoll(true)
      await api(p, VOTER, 0, 10, true); await confirm(p, VOTER, 0, 10)
      await api(p, VOTER, 0, 11, true) // toggle OFF
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
      await confirm(p, VOTER, 0, 11)
      expect(await state(p, VOTER)).to.deep.equal({ total: 0, rows: [] })
    })

    it('multi-select: toggling one of two confirmed options OFF leaves the other counted once', async () => {
      const p = await createPoll(true)
      await api(p, VOTER, 0, 10, true); await confirm(p, VOTER, 0, 10)
      await api(p, VOTER, 1, 11, true); await confirm(p, VOTER, 1, 11)
      await api(p, VOTER, 0, 12, true); await confirm(p, VOTER, 0, 12)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['1:confirmed'] })
    })

    it('single-select: voting again for the option that is already confirmed does not count it twice', async () => {
      const p = await createPoll(false)
      await api(p, VOTER, 0, 10, false); await confirm(p, VOTER, 0, 10)
      await api(p, VOTER, 0, 11, false)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
      await confirm(p, VOTER, 0, 11)
      expect(await state(p, VOTER)).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
    })

    it('the node that took the request converges with a mirror node (ON, OFF, ON)', async () => {
      const origin = await createPoll(true)
      const mirror = await createPoll(true)
      const steps: [number, number][] = [[0, 10], [0, 11], [0, 12]] // [option, cawonce], each a toggle
      for (const [opt, cn] of steps) {
        await api(origin, VOTER, opt, cn, true)
        await confirm(origin, VOTER, opt, cn)
        await confirm(mirror, MIRROR_VOTER, opt, cn) // the mirror only ever runs the indexer
      }
      const o = await state(origin, VOTER)
      const m = await state(mirror, MIRROR_VOTER)
      expect(o).to.deep.equal(m)
      expect(o).to.deep.equal({ total: 1, rows: ['0:confirmed'] })
    })
  })
})
