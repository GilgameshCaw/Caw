// A failed profile update must release User.profileUpdatePending.
//
// /api/actions sets the flag when a profile update is submitted and only a
// successful handleOtherAction clears it. A TxQueue row that ends up 'failed'
// has to release it too, on both failure paths:
//   - markTxQueueFailed -> cleanupOptimisticRows (runs when the row fails)
//   - DataCleaner.cleanupFailedTxQueue (the sweep for rows that were not cleaned)
//
// Integration-style against a real database: both paths run unmodified. Needs
// DATABASE_URL to point at a disposable database whose name contains
// "caw_test_".

process.env.CLIENT_ID = '1'

import { expect } from 'chai'
import SmlTxt from 'smltxt'
import { PrismaClient } from '@prisma/client'

// Importing DataCleaner connects to Elasticsearch and starts a full sync, and
// ES module imports run before any statement in this file. So the guards below
// run first and the two modules are imported afterwards, in before().
// Run with ELASTICSEARCH_NODE set to an unreachable address, for example
//   ELASTICSEARCH_NODE=http://127.0.0.1:1
let markTxQueueFailed: typeof import('../../../src/utils/txQueueFailure').markTxQueueFailed
let cleanupFailedTxQueue: typeof import('../../../src/services/DataCleaner').cleanupFailedTxQueue

const prisma = new PrismaClient()

const SENDER = 91001
const OTHER_SENDER = 91002
const RECIPIENT = 91003

const hex = (text: string) =>
  '0x' + Buffer.from(SmlTxt.fromPkg().compress(text)).toString('hex')

const PROFILE_TEXT = 'p:{"n":"New Name","d":"New bio"}'
const LONG_PROFILE_TEXT = 'profile-update:{"displayName":"New Name","bio":"New bio"}'

let cawonceSeq = 1000
const nextCawonce = () => ++cawonceSeq

function payload(senderId: number, actionType: number | string, text: string, cawonce: number) {
  return { data: { senderId, actionType, cawonce, text, amounts: ['1000'], recipients: [] } }
}

async function addTx(opts: {
  senderId?: number
  status: string
  text: string
  actionType?: number | string
  cawonce?: number
  updatedAt?: Date
}) {
  const senderId = opts.senderId ?? SENDER
  const cawonce = opts.cawonce ?? nextCawonce()
  return prisma.txQueue.create({
    data: {
      senderId,
      cawonce,
      status: opts.status,
      signedTx: '0x00',
      payload: payload(senderId, opts.actionType ?? 7, opts.text, cawonce) as any,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    },
  })
}

const flag = async (tokenId = SENDER) =>
  (await prisma.user.findUnique({ where: { tokenId }, select: { profileUpdatePending: true } }))!.profileUpdatePending

const setFlag = (value: boolean, tokenId = SENDER) =>
  prisma.user.update({ where: { tokenId }, data: { profileUpdatePending: value } })

async function fail(tx: { id: number; senderId: number; payload: any }, reason = 'Transaction reverted') {
  await markTxQueueFailed(prisma as any, tx.id, reason, tx.senderId, tx.payload.data)
}

const tenMinutesAgo = () => new Date(Date.now() - 10 * 60 * 1000)

describe('failed profile update releases profileUpdatePending', function () {
  // The first smltxt use loads the dictionary, and the in-flight test fails several rows.
  this.timeout(120000)

  before(async () => {
    if (!/caw_test_/.test(process.env.DATABASE_URL || '')) {
      throw new Error('needs DATABASE_URL pointing at a caw_test_* database')
    }
    const es = process.env.ELASTICSEARCH_NODE
    if (!es || /localhost|127\.0\.0\.1:9200/.test(es)) {
      throw new Error('needs ELASTICSEARCH_NODE set to an unreachable address (e.g. http://127.0.0.1:1)')
    }
    ;({ markTxQueueFailed } = await import('../../../src/utils/txQueueFailure'))
    ;({ cleanupFailedTxQueue } = await import('../../../src/services/DataCleaner'))

    for (const id of [SENDER, OTHER_SENDER, RECIPIENT]) {
      await prisma.user.upsert({
        where: { tokenId: id },
        update: {},
        create: { id, tokenId: id, username: `pupend${id}` },
      })
    }
  })

  beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [SENDER, OTHER_SENDER] } } })
    await prisma.tip.deleteMany({ where: { senderId: { in: [SENDER, OTHER_SENDER] } } })
    await prisma.txQueue.deleteMany({ where: { senderId: { in: [SENDER, OTHER_SENDER] } } })
    await setFlag(false)
    await setFlag(false, OTHER_SENDER)
  })

  after(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [SENDER, OTHER_SENDER] } } })
    await prisma.tip.deleteMany({ where: { senderId: { in: [SENDER, OTHER_SENDER] } } })
    await prisma.txQueue.deleteMany({ where: { senderId: { in: [SENDER, OTHER_SENDER] } } })
    await prisma.user.deleteMany({ where: { tokenId: { in: [SENDER, OTHER_SENDER, RECIPIENT] } } })
    await prisma.$disconnect()
  })

  describe('markTxQueueFailed (runs when the row fails)', () => {
    it('clears the flag for a compressed "p:" update', async () => {
      await setFlag(true)
      const tx = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(tx)
      expect(await flag()).to.equal(false)
    })

    it('clears the flag for a compressed "profile-update:" update', async () => {
      await setFlag(true)
      const tx = await addTx({ status: 'processing', text: hex(LONG_PROFILE_TEXT) })
      await fail(tx)
      expect(await flag()).to.equal(false)
    })

    it('leaves the flag when the sender has another profile update in flight', async () => {
      for (const status of ['pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit', 'waiting_for_session', 'underpriced']) {
        await prisma.txQueue.deleteMany({ where: { senderId: SENDER } })
        await setFlag(true)
        await addTx({ status, text: hex(PROFILE_TEXT) })
        const failing = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
        await fail(failing)
        expect(await flag(), `sibling status ${status}`).to.equal(true)
      }
    })

    it('leaves the flag when in-flight sibling has actionType "other"', async () => {
      await setFlag(true)
      await addTx({ status: 'pending', text: hex(PROFILE_TEXT), actionType: 'other' })
      const failing = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(failing)
      expect(await flag()).to.equal(true)
    })

    it('leaves the flag when in-flight sibling is stored as plain text', async () => {
      await setFlag(true)
      await addTx({ status: 'pending', text: PROFILE_TEXT, actionType: 7 })
      const failing = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(failing)
      expect(await flag()).to.equal(true)
    })

    it('ignores siblings that can no longer land, other senders, and other action kinds', async () => {
      await setFlag(true)
      await addTx({ status: 'done', text: hex(PROFILE_TEXT) })
      await addTx({ status: 'cancelled', text: hex(PROFILE_TEXT) })
      await addTx({ status: 'failed', text: hex(PROFILE_TEXT) })
      await addTx({ status: 'validated_by_peer', text: hex(PROFILE_TEXT) })
      await addTx({ senderId: OTHER_SENDER, status: 'pending', text: hex(PROFILE_TEXT) })
      await addTx({ status: 'pending', text: hex(`tip:${RECIPIENT}:5`) })
      await addTx({ status: 'pending', text: '0x', actionType: 0 })
      const failing = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(failing)
      expect(await flag()).to.equal(false)
    })

    it('does not touch another user\'s flag', async () => {
      await setFlag(true)
      await setFlag(true, OTHER_SENDER)
      const tx = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(tx)
      expect(await flag()).to.equal(false)
      expect(await flag(OTHER_SENDER)).to.equal(true)
    })

    it('leaves the flag alone when a different OTHER action fails', async () => {
      await setFlag(true)
      const tx = await addTx({ status: 'processing', text: hex(`tip:${RECIPIENT}:5`) })
      await fail(tx)
      expect(await flag()).to.equal(true)
    })

    it('does not throw for a flag that is already clear or for corrupt text', async () => {
      const a = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(a)
      expect(await flag()).to.equal(false)

      await setFlag(true)
      const b = await addTx({ status: 'processing', text: '0xzz' })
      await fail(b)
      expect(await flag()).to.equal(true)
    })

    it('still marks the row failed and keeps the failure notification', async () => {
      await setFlag(true)
      const tx = await addTx({ status: 'processing', text: hex(PROFILE_TEXT) })
      await fail(tx)
      const row = await prisma.txQueue.findUnique({ where: { id: tx.id } })
      expect(row!.status).to.equal('failed')
      const notes = await prisma.notification.count({ where: { userId: SENDER, type: 'ACTION_FAILED' } })
      expect(notes).to.equal(1)
    })
  })

  describe('DataCleaner.cleanupFailedTxQueue (sweep of failed rows)', () => {
    it('clears the flag for a failed, compressed profile update', async () => {
      await setFlag(true)
      await addTx({ status: 'failed', text: hex(PROFILE_TEXT), updatedAt: tenMinutesAgo() })
      await cleanupFailedTxQueue()
      expect(await flag()).to.equal(false)
    })

    it('still handles a plain-text update stored with actionType "other"', async () => {
      await setFlag(true)
      await addTx({ status: 'failed', text: PROFILE_TEXT, actionType: 'other', updatedAt: tenMinutesAgo() })
      await cleanupFailedTxQueue()
      expect(await flag()).to.equal(false)
    })

    it('leaves the flag when another profile update is in flight', async () => {
      await setFlag(true)
      await addTx({ status: 'failed', text: hex(PROFILE_TEXT), updatedAt: tenMinutesAgo() })
      await addTx({ status: 'pending', text: hex(PROFILE_TEXT) })
      await cleanupFailedTxQueue()
      expect(await flag()).to.equal(true)
    })

    it('leaves rows that failed less than 5 minutes ago for a later tick', async () => {
      await setFlag(true)
      await addTx({ status: 'failed', text: hex(PROFILE_TEXT) })
      await cleanupFailedTxQueue()
      expect(await flag()).to.equal(true)
    })

    it('removes a pending tip for a failed, compressed tip and keeps a confirmed one', async () => {
      const cawonce = nextCawonce()
      await prisma.tip.create({
        data: { senderId: SENDER, recipientId: RECIPIENT, amount: 5, cawonce, pending: true },
      })
      const keptCawonce = nextCawonce()
      await prisma.tip.create({
        data: { senderId: SENDER, recipientId: RECIPIENT, amount: 5, cawonce: keptCawonce, pending: false },
      })
      await addTx({ status: 'failed', text: hex(`tip:${RECIPIENT}:5`), cawonce, updatedAt: tenMinutesAgo() })
      await cleanupFailedTxQueue()
      expect(await prisma.tip.count({ where: { senderId: SENDER, cawonce } })).to.equal(0)
      expect(await prisma.tip.count({ where: { senderId: SENDER, cawonce: keptCawonce } })).to.equal(1)
    })

    it('does not throw on corrupt text and moves on to the next row', async () => {
      await setFlag(true)
      await addTx({ status: 'failed', text: '0xzz', updatedAt: new Date(Date.now() - 20 * 60 * 1000) })
      await addTx({ status: 'failed', text: hex(PROFILE_TEXT), updatedAt: tenMinutesAgo() })
      await cleanupFailedTxQueue()
      expect(await flag()).to.equal(false)
    })
  })
})
