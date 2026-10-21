import { expect } from 'chai'
import { waitForReceipt, TxWaitTimeoutError, TX_WAIT_TIMEOUT_CODE } from '../../src/utils/txWait'

// Fake sent tx: only the surface waitForReceipt calls (hash + wait).
function makeTx(wait: (confirms?: number, timeout?: number) => Promise<any>) {
  const calls: Array<[number | undefined, number | undefined]> = []
  return {
    calls,
    tx: {
      hash: '0xabc',
      wait(confirms?: number, timeout?: number) {
        calls.push([confirms, timeout])
        return wait(confirms, timeout)
      },
    },
  }
}

const never = () => new Promise<any>(() => {})

describe('waitForReceipt', () => {
  it('returns the receipt and passes the timeout to tx.wait', async () => {
    const { tx, calls } = makeTx(async () => ({ blockNumber: 7 }))
    const receipt = await waitForReceipt(tx, 1_000)
    expect(receipt).to.deep.equal({ blockNumber: 7 })
    expect(calls).to.deep.equal([[1, 1_000]])
  })

  it('rejects with TxWaitTimeoutError when tx.wait never settles', async () => {
    const { tx } = makeTx(never)
    const started = Date.now()
    const err = await waitForReceipt(tx, 50).then(() => null, e => e)
    expect(err).to.be.instanceOf(TxWaitTimeoutError)
    expect(err.code).to.equal(TX_WAIT_TIMEOUT_CODE)
    expect(err.txHash).to.equal('0xabc')
    expect(Date.now() - started).to.be.lessThan(1_000)
  })

  it("maps ethers' TIMEOUT to TxWaitTimeoutError", async () => {
    const { tx } = makeTx(async () => {
      throw Object.assign(new Error('wait for transaction timeout'), { code: 'TIMEOUT' })
    })
    const err = await waitForReceipt(tx, 1_000).then(() => null, e => e)
    expect(err).to.be.instanceOf(TxWaitTimeoutError)
  })

  it('passes other errors through unchanged (a revert is not a timeout)', async () => {
    const revert = Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION' })
    const { tx } = makeTx(async () => { throw revert })
    const err = await waitForReceipt(tx, 1_000).then(() => null, e => e)
    expect(err).to.equal(revert)
  })

  // The validator's callers decide "transient → back to pending" by message
  // (isTransientRpcError and the two submit catches all match "timeout").
  // submitProcessActions' own retry re-sends on code TIMEOUT and on messages
  // containing "nonce" / "ETIMEDOUT" / "network error"; the timeout error must
  // match none of those, so it is not re-sent.
  it('is classified as transient by message, and does not match the re-send ladder', async () => {
    const { tx } = makeTx(never)
    const err = await waitForReceipt(tx, 10).then(() => null, e => e)
    const msg = err.message as string
    expect(msg.toLowerCase()).to.include('timeout')
    expect(err.code).to.not.equal('TIMEOUT')
    for (const s of ['nonce', 'ETIMEDOUT', 'network error', 'fetch failed', 'ECONNREFUSED', 'error sending request', 'could not coalesce', 'already known', 'replacement transaction underpriced', 'oversized data']) {
      expect(msg).to.not.include(s)
    }
  })

  it('clears its timer when the receipt arrives first', async () => {
    const { tx } = makeTx(async () => ({ blockNumber: 1 }))
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    const created: any[] = []
    const cleared: any[] = []
    ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...args: any[]) => {
      const h = realSet(fn, ms, ...args)
      if (ms === 60_000) created.push(h)
      return h
    }
    ;(globalThis as any).clearTimeout = (h: any) => { cleared.push(h); return realClear(h) }
    try {
      await waitForReceipt(tx, 60_000)
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
    expect(created).to.have.length(1)
    expect(cleared).to.include(created[0])
  })
})
