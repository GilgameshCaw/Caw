// Tests for the ScheduledCaw demotion in markTxQueueFailed →
// cleanupOptimisticRows.
//
// A CAW that came from /scheduled sits at ScheduledCaw.status='published'
// once its TxQueue row is created. When that row fails, the scheduled
// record is demoted to 'failed'. That is wrong when the same signed
// action is already indexed for (senderId, cawonce): the failure belongs
// to a sibling submission (e.g. a peer mirror won the race and this row
// got "Cawonce already used"), and the post itself is on chain.

import { expect } from 'chai'
import SmlTxt from 'smltxt'
import { markTxQueueFailed } from '../../src/utils/txQueueFailure'

const smlTxt = SmlTxt.fromPkg()
function compress(text: string): string {
  return '0x' + Buffer.from(smlTxt.compress(text)).toString('hex')
}

const SENDER = 42
const CAWONCE = 7

function signedCaw(text: string, extra: Partial<any> = {}) {
  return {
    actionType: 0,
    senderId: SENDER,
    cawonce: CAWONCE,
    receiverId: 0,
    receiverCawonce: 0,
    text: compress(text),
    ...extra,
  }
}

interface FakeOpts {
  // Action.data for (SENDER, CAWONCE), as RawEventsGatherer stores it
  // (plaintext text, numeric actionType). null = not indexed yet.
  indexed?: any | null
  actionLookupThrows?: boolean
  // caw.updateMany result count (0 = Caw row no longer PENDING).
  cawPendingCount?: number
}

function makeFakePrisma(opts: FakeOpts = {}) {
  const scheduledDemotions: any[] = []
  const actionLookups: any[] = []
  const prisma: any = {
    // The Caw FAILED update may run in an interactive transaction
    // (see the TOCTOU fix in #68); hand the same fake to the callback.
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    txQueue: {
      findUnique: async () => ({ batchId: null }),
      update: async () => ({}),
    },
    caw: {
      findMany: async () => [],
      updateMany: async () => ({ count: opts.cawPendingCount ?? 1 }),
    },
    scheduledCaw: {
      updateMany: async (args: any) => {
        scheduledDemotions.push(args)
        return { count: 1 }
      },
    },
    action: {
      findFirst: async (args: any) => {
        actionLookups.push(args)
        if (opts.actionLookupThrows) throw new Error('db down')
        const w = args?.where ?? {}
        if (opts.indexed && w.senderId === SENDER && w.cawonce === CAWONCE) {
          return { data: opts.indexed }
        }
        return null
      },
    },
    // Every test fails with "Cawonce already used", which returns before
    // the ACTION_FAILED notification (that path reaches the shared prisma
    // client, not this fake).
    notification: {
      findFirst: async () => null,
    },
  }
  return { prisma, scheduledDemotions, actionLookups }
}

describe('markTxQueueFailed — ScheduledCaw demotion', () => {
  it('keeps the scheduled post published when the same signed action is already indexed', async () => {
    const data = signedCaw('scheduled hello')
    const f = makeFakePrisma({
      indexed: { actionType: 0, senderId: SENDER, cawonce: CAWONCE, receiverId: 0, receiverCawonce: 0, text: 'scheduled hello' },
      cawPendingCount: 0,
    })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, data)
    expect(f.actionLookups).to.have.length(1)
    expect(f.scheduledDemotions).to.deep.equal([])
  })

  it('keeps a scheduled thread reply published when the same reply is already indexed', async () => {
    const data = signedCaw('part 2', { receiverId: SENDER, receiverCawonce: 6 })
    const f = makeFakePrisma({
      indexed: { actionType: 0, senderId: SENDER, cawonce: CAWONCE, receiverId: SENDER, receiverCawonce: 6, text: 'part 2' },
    })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, data)
    expect(f.scheduledDemotions).to.deep.equal([])
  })

  it('demotes when a different action holds the cawonce on chain', async () => {
    const data = signedCaw('scheduled hello')
    const f = makeFakePrisma({
      indexed: { actionType: 0, senderId: SENDER, cawonce: CAWONCE, receiverId: 0, receiverCawonce: 0, text: 'something else' },
    })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, data)
    expect(f.scheduledDemotions).to.have.length(1)
    expect(f.scheduledDemotions[0]).to.deep.equal({
      where: { userId: SENDER, cawonce: CAWONCE, status: 'published' },
      data: { status: 'failed' },
    })
  })

  it('demotes when the indexed action at that cawonce is a different reply target', async () => {
    const data = signedCaw('part 2', { receiverId: SENDER, receiverCawonce: 6 })
    const f = makeFakePrisma({
      indexed: { actionType: 0, senderId: SENDER, cawonce: CAWONCE, receiverId: 0, receiverCawonce: 0, text: 'part 2' },
    })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, data)
    expect(f.scheduledDemotions).to.have.length(1)
  })

  it('demotes when nothing is indexed for (sender, cawonce)', async () => {
    const f = makeFakePrisma({ indexed: null })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, signedCaw('scheduled hello'))
    expect(f.scheduledDemotions).to.have.length(1)
  })

  it('demotes when the Caw row was already swept to FAILED and nothing is indexed', async () => {
    // DataCleaner.cleanupPendingCaws marks a 30-minute-old PENDING Caw
    // FAILED without touching ScheduledCaw; a later TxQueue failure must
    // still demote it.
    const f = makeFakePrisma({ indexed: null, cawPendingCount: 0 })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, signedCaw('scheduled hello'))
    expect(f.scheduledDemotions).to.have.length(1)
  })

  it('demotes when the Action lookup fails', async () => {
    const f = makeFakePrisma({ actionLookupThrows: true })
    await markTxQueueFailed(f.prisma as any, 1, 'Cawonce already used', SENDER, signedCaw('scheduled hello'))
    expect(f.scheduledDemotions).to.have.length(1)
  })
})
