// Tests for CountManager.onCawCreated's isReply handling.
//
// Regression test for a bug where ActionProcessor's actionHandlers.ts
// (handleCawAction / handleOtherAction) computed isReplyNotQuote but never
// passed it to onCawCreated, causing every peer-mirrored reply to be
// counted as a top-level post — inflating User.cawCount and causing
// cawCount to diverge between nodes depending on whether a caw was
// submitted locally (API route, which did pass isReply correctly) or
// received via on-chain event replay (ActionProcessor, which did not).
//
// Verified against production data on cawnest.com (2026-09-06): a
// peer-mirrored user's User.cawCount exactly equalled
// (root/quote posts + replies + hidden posts) — i.e. every reply had
// been folded into cawCount — while a locally-submitted user's
// cawCount excluded their replies entirely, confirming the two code
// paths diverged.

import { expect } from 'chai'
import { countManager } from '../../src/services/CountManager'

interface FakeTx {
  caw: { update: (args: any) => Promise<void> }
  user: { update: (args: any) => Promise<void> }
  cawUpdates: Array<{ id: number; data: any }>
  userUpdates: Array<{ tokenId: number; data: any }>
}

function makeFakeTx(): FakeTx {
  const cawUpdates: Array<{ id: number; data: any }> = []
  const userUpdates: Array<{ tokenId: number; data: any }> = []
  return {
    cawUpdates,
    userUpdates,
    caw: {
      update: async ({ where, data }: any) => {
        cawUpdates.push({ id: where.id, data })
      },
    },
    user: {
      update: async ({ where, data }: any) => {
        userUpdates.push({ tokenId: where.tokenId, data })
      },
    },
  }
}

describe('CountManager.onCawCreated — isReply flag', () => {
  it('increments user.cawCount for a top-level post (isReply omitted)', async () => {
    const tx = makeFakeTx()
    await countManager.onCawCreated(tx as any, {
      id: 1001,
      userId: 42,
      action: 'CAW',
      originalCawId: null,
      status: 'SUCCESS',
    })
    expect(tx.userUpdates).to.deep.equal([
      { tokenId: 42, data: { cawCount: { increment: 1 } } },
    ])
  })

  it('does NOT increment user.cawCount for a reply (isReply: true)', async () => {
    const tx = makeFakeTx()
    await countManager.onCawCreated(tx as any, {
      id: 1002,
      userId: 42,
      action: 'CAW',
      originalCawId: null,
      status: 'SUCCESS',
      isReply: true,
    })
    expect(tx.userUpdates).to.deep.equal([])
  })

  it('regression: a reply with isReply omitted is wrongly counted as a top-level post', async () => {
    // This reproduces the pre-fix bug condition: actionHandlers.ts computed
    // isReplyNotQuote but never passed it through, so onCawCreated always
    // saw isReply === undefined for peer-mirrored replies.
    const tx = makeFakeTx()
    await countManager.onCawCreated(tx as any, {
      id: 1003,
      userId: 42,
      action: 'CAW',
      originalCawId: null,
      status: 'SUCCESS',
      // isReply omitted entirely, as the buggy call site did
    })
    expect(tx.userUpdates).to.deep.equal([
      { tokenId: 42, data: { cawCount: { increment: 1 } } },
    ])
  })

  it('still bumps parent recawCount for a quote (CAW with originalCawId), independent of isReply', async () => {
    const tx = makeFakeTx()
    await countManager.onCawCreated(tx as any, {
      id: 1004,
      userId: 42,
      action: 'CAW',
      originalCawId: 999,
      status: 'SUCCESS',
      isReply: false,
    })
    expect(tx.userUpdates).to.deep.equal([
      { tokenId: 42, data: { cawCount: { increment: 1 } } },
    ])
    expect(tx.cawUpdates).to.deep.equal([
      { id: 999, data: { recawCount: { increment: 1 } } },
    ])
  })
})
