/**
 * POST /api/actions/batch, per-action signature path: a WebAuthn blob is
 * accepted only when verifyERC1271Sig returns 'ok'.
 *
 * verifyERC1271Sig returns 'ok' | 'bad_sig' | 'not_delegated'. All three are
 * truthy strings, so a boolean check (`if (!ok)`) accepts every blob, and
 * also accepts the 'bad_sig' it returns when the RPC read throws. Both batch
 * sites are covered: the first action, and the per-action loop.
 *
 * Runs the real router. Its imports that would reach Postgres, Redis or the
 * L2 RPC are replaced in require.cache before the router is loaded, and put
 * back afterwards:
 *   - prismaClient: an in-memory sender row and TxQueue table;
 *   - rpcProvider: a provider whose isValidSignature answers the magic value
 *     only for GOOD_SIG;
 *   - sessionStore, freeActionRateLimit, indexerPoke: they open Redis
 *     connections at import time. The owner-signed batch path calls none of
 *     them.
 */

import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import { Interface } from 'ethers'

const SENDER_ID = 7
const OWNER = '0x' + 'ab'.repeat(20)
const GOOD_SIG = '0x' + '11'.repeat(66) // > 65 bytes: a WebAuthn blob
const JUNK_SIG = '0x' + '22'.repeat(66)
const ERC1271_MAGIC = '0x1626ba7e'
const DELEGATED_CODE = '0xef0100' + 'cc'.repeat(20)

const DOMAIN = { name: 'Caw Protocol', version: '1', chainId: 84532, verifyingContract: '0x' + 'aa'.repeat(20) }
const TYPES = {
  ActionData: [
    { name: 'actionType',      type: 'uint8'    },
    { name: 'senderId',        type: 'uint32'   },
    { name: 'receiverId',      type: 'uint32'   },
    { name: 'receiverCawonce', type: 'uint32'   },
    { name: 'networkId',       type: 'uint32'   },
    { name: 'cawonce',         type: 'uint32'   },
    { name: 'recipients',      type: 'uint32[]' },
    { name: 'amounts',         type: 'uint64[]' },
    { name: 'text',            type: 'bytes'    },
  ],
}

// A like (actionType 1): the batch writes only the TxQueue row for it.
function action(cawonce: number, signature: string) {
  return {
    data: { actionType: 1, senderId: SENDER_ID, receiverId: 8, receiverCawonce: 1, networkId: 1, cawonce, recipients: [], amounts: [], text: '0x' },
    domain: DOMAIN,
    types: TYPES,
    signature,
  }
}

// ─── Stubs ───────────────────────────────────────────────────────────────────

const erc1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const rpc = { code: DELEGATED_CODE, callThrows: false }
const fakeProvider = {
  async getCode(_addr: string) { return rpc.code },
  async call(tx: { data: string }) {
    if (rpc.callThrows) throw new Error('connection refused')
    const [, sig] = erc1271.decodeFunctionData('isValidSignature', tx.data)
    return erc1271.encodeFunctionResult('isValidSignature', [sig === GOOD_SIG ? ERC1271_MAGIC : '0xffffffff'])
  },
}

let queued: any[] = []
const prismaStub: any = {
  user: {
    findUnique: async ({ where }: any) => (where.tokenId === SENDER_ID ? { tokenId: SENDER_ID, address: OWNER } : null),
  },
  txQueue: {
    findMany: async () => [],
    findFirst: async () => null,
    create: async ({ data }: any) => {
      const row = { id: queued.length + 1, ...data }
      queued.push(row)
      return row
    },
  },
  notification: { updateMany: async () => ({ count: 0 }) },
  $transaction: async (fn: (tx: any) => any) => fn(prismaStub),
}

const notCalled = (name: string) => async () => { throw new Error(`${name} must not be called on this path`) }

const STUBS: Record<string, any> = {
  '../../../src/prismaClient': { prisma: prismaStub },
  '../../../src/utils/rpcProvider': {
    getL2HttpRpcUrl: () => 'http://l2.invalid',
    makeVerifiedJsonRpcProvider: async () => fakeProvider,
    makeVerifiedWebSocketProvider: async () => fakeProvider,
  },
  '../../../src/api/sessionStore': {
    getSession: notCalled('getSession'),
    addAuthorization: notCalled('addAuthorization'),
    createSession: notCalled('createSession'),
  },
  '../../../src/api/freeActionRateLimit': { checkFreeActionRate: notCalled('checkFreeActionRate'), FREE_ACTION_CODES: new Set([2, 5]) },
  '../../../src/api/util/indexerPoke': { pokeIndexTokenId: () => {} },
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/actions/batch: ERC-1271 per-action signatures', () => {
  const saved = new Map<string, NodeJS.Module | undefined>()
  let actionsPath = ''
  let app: express.Express

  before(() => {
    actionsPath = require.resolve('../../../src/api/routes/actions')
    for (const p of [actionsPath, ...Object.keys(STUBS).map(rel => require.resolve(rel))]) saved.set(p, require.cache[p])
    for (const [rel, exports] of Object.entries(STUBS)) {
      const p = require.resolve(rel)
      require.cache[p] = { id: p, filename: p, loaded: true, exports } as any
    }
    delete require.cache[actionsPath]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../../../src/api/routes/actions').default
    app = express()
    app.use(express.json())
    app.use('/api/actions', router)
  })

  after(() => {
    for (const [p, mod] of saved) {
      if (mod) require.cache[p] = mod
      else delete require.cache[p]
    }
  })

  beforeEach(() => {
    queued = []
    rpc.code = DELEGATED_CODE
    rpc.callThrows = false
  })

  it('queues blobs that verify, as erc1271 rows', async () => {
    const res = await request(app).post('/api/actions/batch').send({ actions: [action(10, GOOD_SIG), action(11, GOOD_SIG)] })
    expect(res.status, JSON.stringify(res.body)).to.equal(201)
    expect(queued.map(r => r.signerKind)).to.deep.equal(['erc1271', 'erc1271'])
  })

  it('rejects the batch when the first blob does not verify', async () => {
    const res = await request(app).post('/api/actions/batch').send({ actions: [action(10, JUNK_SIG)] })
    expect(res.status, JSON.stringify(res.body)).to.equal(400)
    expect(queued).to.have.length(0)
  })

  it('rejects a later action whose blob does not verify, and queues the rest', async () => {
    const res = await request(app).post('/api/actions/batch').send({ actions: [action(10, GOOD_SIG), action(11, JUNK_SIG)] })
    expect(res.status, JSON.stringify(res.body)).to.equal(201)
    expect(res.body.results[1].error).to.equal('Invalid signature')
    expect(queued.map(r => r.cawonce)).to.deep.equal([10])
  })

  it('fails closed when the RPC read throws', async () => {
    rpc.callThrows = true
    const res = await request(app).post('/api/actions/batch').send({ actions: [action(10, GOOD_SIG)] })
    expect(res.status, JSON.stringify(res.body)).to.equal(400)
    expect(queued).to.have.length(0)
  })

  it('rejects an owner with no code on the L2 (not_delegated)', async () => {
    rpc.code = '0x'
    const res = await request(app).post('/api/actions/batch').send({ actions: [action(10, GOOD_SIG)] })
    expect(res.status, JSON.stringify(res.body)).to.equal(400)
    expect(queued).to.have.length(0)
  })
})
