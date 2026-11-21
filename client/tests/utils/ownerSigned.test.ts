/**
 * recordOwnerSet / ownerHasSigned.
 *
 * No database: the Prisma calls are replaced on the model delegates (an
 * in-memory TokenOwnerSince table and an action.findFirst stub), and the test
 * checks what was stored and what was asked for.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'

describe('ownerSigned', function () {
  this.timeout(30000)

  let recordOwnerSet: (t: number, o: string, b: number, l: number) => Promise<void>
  let ownerHasSigned: (t: number) => Promise<boolean>
  let table: Map<number, any>
  let upserts: number
  let actionCalls: any[]
  // L2 blocks of the token's actions; action.findFirst answers by the block
  // condition in the query.
  let actionBlocks: bigint[]
  let restore: () => void = () => {}

  before(async () => {
    const { prisma } = await import('../../src/prismaClient')
    const mod = await import('../../src/utils/ownerSigned')
    recordOwnerSet = mod.recordOwnerSet
    ownerHasSigned = mod.ownerHasSigned
    const restores: Array<() => void> = []
    const stub = (modelName: string, method: string, fn: (args: any) => any) => {
      const model: any = (prisma as any)[modelName]
      const had = Object.prototype.hasOwnProperty.call(model, method)
      const prev = model[method]
      model[method] = fn
      restores.push(() => { if (had) model[method] = prev; else delete model[method] })
    }
    stub('tokenOwnerSince', 'findUnique', async (a: any) => table.get(a.where.tokenId) ?? null)
    stub('tokenOwnerSince', 'upsert', async (a: any) => {
      upserts++
      const cur = table.get(a.where.tokenId)
      const next = cur ? { ...cur, ...a.update } : { ...a.create }
      table.set(a.where.tokenId, next)
      return next
    })
    stub('action', 'findFirst', async (a: any) => {
      actionCalls.push(a)
      const c = a.where.rawEvent?.blockNumber
      const hit = actionBlocks.find(b => !c || (c.gt !== undefined && b > c.gt) || (c.lte !== undefined && b <= c.lte))
      return hit === undefined ? null : { id: 1 }
    })
    restore = () => restores.forEach(r => r())
  })

  after(() => restore())

  beforeEach(() => { table = new Map(); upserts = 0; actionCalls = []; actionBlocks = [] })

  describe('recordOwnerSet', () => {
    it('stores the owner (lowercased) and the L2 position of the first OwnerSet', async () => {
      await recordOwnerSet(7, '0xABCDEF0000000000000000000000000000000001', 100, 3)
      expect(table.get(7)).to.deep.include({ owner: '0xabcdef0000000000000000000000000000000001', sinceBlock: 100n, sinceLogIndex: 3 })
    })

    it('moves to the new position when the owner changes', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      await recordOwnerSet(7, '0xbbbb000000000000000000000000000000000002', 250, 1)
      expect(table.get(7)).to.deep.include({ owner: '0xbbbb000000000000000000000000000000000002', sinceBlock: 250n, sinceLogIndex: 1 })
    })

    it('ignores a re-stamp of the same owner (not a change of owner)', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      await recordOwnerSet(7, '0xAAAA000000000000000000000000000000000001', 400, 0)
      expect(table.get(7).sinceBlock).to.equal(100n)
      expect(upserts).to.equal(1)
    })

    it('ignores an older event (a replay from an earlier cursor)', async () => {
      await recordOwnerSet(7, '0xbbbb000000000000000000000000000000000002', 250, 1)
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      expect(table.get(7)).to.deep.include({ owner: '0xbbbb000000000000000000000000000000000002', sinceBlock: 250n })
    })

    it('orders two owner changes in one block by log index', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 2)
      await recordOwnerSet(7, '0xbbbb000000000000000000000000000000000002', 100, 5)
      expect(table.get(7).owner).to.equal('0xbbbb000000000000000000000000000000000002')
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 2)
      expect(table.get(7).owner).to.equal('0xbbbb000000000000000000000000000000000002')
    })
  })

  describe('ownerHasSigned', () => {
    it('no OwnerSet seen: any action of the name counts', async () => {
      actionBlocks = [10n]
      expect(await ownerHasSigned(7)).to.equal(true)
      expect(actionCalls[0].where).to.deep.equal({ senderId: 7 })
    })

    it('no action at all: false', async () => {
      expect(await ownerHasSigned(7)).to.equal(false)
    })

    it('a mint (first OwnerSet, no action before it): only actions in a later L2 block count', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      actionBlocks = []
      expect(await ownerHasSigned(7)).to.equal(false)
      actionBlocks = [150n]
      expect(await ownerHasSigned(7)).to.equal(true)
      expect(actionCalls.at(-1).where).to.deep.equal({ senderId: 7, rawEvent: { blockNumber: { gt: 100n } } })
    })

    it('a change from an owner on record: the earlier owner\'s actions do not count', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      await recordOwnerSet(7, '0xbbbb000000000000000000000000000000000002', 300, 0)
      actionBlocks = [150n, 200n]
      expect(await ownerHasSigned(7)).to.equal(false)
      actionBlocks = [150n, 350n]
      expect(await ownerHasSigned(7)).to.equal(true)
    })

    it('the first OwnerSet seen for a name already in use is not a known change: all its actions count', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 300, 0)
      actionBlocks = [150n]
      expect(await ownerHasSigned(7)).to.equal(true)
    })

    it('a re-stamp of the same owner after a mint does not move the boundary', async () => {
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 100, 0)
      await recordOwnerSet(7, '0xaaaa000000000000000000000000000000000001', 120, 0)
      actionBlocks = [110n]
      expect(await ownerHasSigned(7)).to.equal(true)
    })
  })
})
