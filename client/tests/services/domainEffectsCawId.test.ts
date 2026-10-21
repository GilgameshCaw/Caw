// processDomainEffects must hand the Caw row of a CAW action back to its
// caller, so the caller can index it after the transaction commits (I32).
//
// Uses a fake tx: every model call is answered in memory. The modules are
// imported in before() because importing them starts the Elasticsearch
// and Redis singletons; both are pointed at a closed port first so the test
// can't reach a real cluster or the node's Redis.

import { expect } from 'chai'

const NEW_CAW_ID = 77

function makeFakeTx() {
  const calls: string[] = []
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      calls.push(`${name}.${method}`)
      if (method === 'findUnique' || method === 'findFirst') return null
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'upsert' || method === 'create') {
        return { id: NEW_CAW_ID, createdAt: new Date(), ...(args?.create ?? args?.data ?? {}) }
      }
      return {}
    },
  })
  const tx = new Proxy({}, {
    get: (_t, name: string) => {
      if (name.startsWith('$')) return async () => []
      return model(name)
    },
  })
  return { tx: tx as any, calls }
}

describe('processDomainEffects returns the Caw row to index', () => {
  let processDomainEffects: any
  let quiet: typeof console.log

  before(async () => {
    process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1'
    delete process.env.ELASTICSEARCH_API_KEY
    process.env.REDIS_URL = 'redis://127.0.0.1:1'
    ;({ processDomainEffects } = await import('../../src/services/ActionProcessor/domainProcessor'))
  })

  beforeEach(() => {
    quiet = console.log
    console.log = () => {}
  })
  afterEach(() => {
    console.log = quiet
  })

  it('CAW: returns the upserted row id', async () => {
    const { tx, calls } = makeFakeTx()
    const effects = await processDomainEffects(
      tx,
      { actionType: 'CAW', cawonce: 5 },
      { senderId: 1, cawonce: 5, text: 'hello', networkId: process.env.NETWORK_ID ?? process.env.CLIENT_ID },
      { authorId: 1 },
    )
    expect(calls).to.include('caw.upsert')
    expect(effects).to.deep.equal({ cawId: NEW_CAW_ID })
  })

  it('an action type that writes no Caw returns no cawId', async () => {
    const { tx } = makeFakeTx()
    const warn = console.warn
    console.warn = () => {}
    try {
      const effects = await processDomainEffects(tx, { actionType: 'NOPE', cawonce: 5 }, { senderId: 1, cawonce: 5 }, { authorId: 1 })
      expect(effects).to.deep.equal({})
    } finally {
      console.warn = warn
    }
  })
})
