import { expect } from 'chai'
import { InFlightTxs, actionKey, type InFlightChain } from '../../src/utils/inFlightTxs'

const ADDR = '0x00000000000000000000000000000000000000aa'

// A chain where nothing is mined unless the test says so.
function chain(opts: {
  receipts?: Set<string>
  minedCount?: number
  receiptThrows?: boolean
  countThrows?: boolean
} = {}): InFlightChain & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async getTransactionReceipt(hash: string) {
      calls.push(`receipt ${hash}`)
      if (opts.receiptThrows) throw new Error('missing response')
      return opts.receipts?.has(hash) ? { hash } : null
    },
    async getTransactionCount(address: string, tag: 'latest') {
      calls.push(`count ${address} ${tag}`)
      if (opts.countThrows) throw new Error('missing response')
      return opts.minedCount ?? 0
    },
  }
}

// A timed-out tx may still land, so its actions are held from the next
// polls until it settles. These cover when a hold is kept and dropped.
describe('InFlightTxs', () => {
  let t = 1_000_000
  const now = () => t
  const MAX = 10 * 60_000

  beforeEach(() => { t = 1_000_000 })

  it('holds the actions of a timed-out tx', () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, [actionKey(5, 1), actionKey(5, 2)])
    expect([...f.heldKeys()]).to.deep.equal(['5-1', '5-2'])
    expect(f.size).to.equal(1)
  })

  it('normalises string ids in actionKey', () => {
    expect(actionKey('5', '01')).to.equal(actionKey(5, 1))
  })

  it('keeps the hold while there is no receipt and the nonce is not mined', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    t += MAX - 1
    const settled = await f.settle(chain({ minedCount: 7 }), ADDR)
    expect(settled).to.deep.equal([])
    expect([...f.heldKeys()]).to.deep.equal(['5-1'])
  })

  it('drops the hold when the tx has a receipt', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    const settled = await f.settle(chain({ receipts: new Set(['0xa']) }), ADDR)
    expect(settled.map(s => s.reason)).to.deep.equal(['receipt'])
    expect(f.size).to.equal(0)
  })

  it('drops the hold when the mined nonce has moved past it', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    // count 8 = nonces 0..7 are mined, by some other tx since 0xa has no receipt.
    const c = chain({ minedCount: 8 })
    const settled = await f.settle(c, ADDR)
    expect(settled.map(s => s.reason)).to.deep.equal(['nonce-used'])
    expect(c.calls).to.include(`count ${ADDR} latest`)
    expect(f.size).to.equal(0)
  })

  it('drops the hold after maxHoldMs without asking the chain', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    t += MAX
    const c = chain()
    const settled = await f.settle(c, ADDR)
    expect(settled.map(s => s.reason)).to.deep.equal(['expired'])
    expect(c.calls).to.deep.equal([])
    expect(f.size).to.equal(0)
  })

  it('keeps the hold when the receipt lookup throws', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    expect(await f.settle(chain({ receiptThrows: true, minedCount: 0 }), ADDR)).to.deep.equal([])
    expect(f.size).to.equal(1)
  })

  it('keeps the hold when the nonce lookup throws', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    expect(await f.settle(chain({ countThrows: true }), ADDR)).to.deep.equal([])
    expect(f.size).to.equal(1)
  })

  // A hung RPC call must not stall the poll past the watchdog: each check
  // gives up after callTimeoutMs and keeps the hold, as for an RPC error.
  it('keeps the holds when the chain does not answer within callTimeoutMs', async () => {
    const f = new InFlightTxs(MAX, now, 20)
    f.add('0xa', 7, ['5-1'])
    const hung: InFlightChain = {
      getTransactionReceipt: () => new Promise(() => {}),
      getTransactionCount: () => new Promise(() => {}),
    }
    const started = Date.now()
    expect(await f.settle(hung, ADDR)).to.deep.equal([])
    expect(Date.now() - started).to.be.below(1000)
    expect(f.size).to.equal(1)
  })

  it('settles each tx on its own', async () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])          // landed
    t += 1000
    f.add('0xb', 8, ['6-1'])          // nonce 8 not mined yet
    t += 1000
    f.add('0xc', 9, ['7-1', '7-2'])  // still waiting
    const settled = await f.settle(chain({ receipts: new Set(['0xa']), minedCount: 8 }), ADDR)
    expect(settled.map(s => [s.tx.hash, s.reason])).to.deep.equal([['0xa', 'receipt']])
    expect([...f.heldKeys()].sort()).to.deep.equal(['6-1', '7-1', '7-2'])
  })

  it('replaces the entry when the same hash is added again', () => {
    const f = new InFlightTxs(MAX, now)
    f.add('0xa', 7, ['5-1'])
    t += 5000
    f.add('0xa', 7, ['5-1', '5-2'])
    expect(f.size).to.equal(1)
    expect([...f.heldKeys()]).to.deep.equal(['5-1', '5-2'])
  })

  // The poll-level effect, modelled: one poll per tick, a chain that mines
  // nothing for `haltTicks`, and a send that times out while halted. With
  // the hold the rows go out once; without it, once per poll.
  it('model: one send for a halted chain instead of one per poll', async () => {
    const run = async (useHold: boolean) => {
      const f = new InFlightTxs(MAX, now)
      const rows = ['5-1', '5-2']
      let sends = 0
      let nonce = 0
      for (let tick = 0; tick < 15; tick++) {
        t += 30_000 // checkInterval-ish
        await f.settle(chain({ minedCount: 0 }), ADDR)
        const held = useHold ? f.heldKeys() : new Set<string>()
        const toSend = rows.filter(r => !held.has(r))
        if (toSend.length === 0) continue
        sends++
        f.add(`0x${tick}`, nonce, toSend) // the receipt wait times out
      }
      return sends
    }
    expect(await run(true)).to.equal(1)
    expect(await run(false)).to.equal(15)
  })
})
