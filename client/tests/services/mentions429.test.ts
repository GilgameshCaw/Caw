import { expect } from 'chai'
import { makeError, FetchRequest, FetchResponse } from 'ethers'
import { mentions429 } from '../../src/utils/mentions429'

// A reverted tx's error, the way tx.wait() throws it: the receipt and tx in
// the key=value part carry hex and numbers.
function revertWith(receipt: Record<string, unknown>) {
  return makeError('transaction execution reverted', 'CALL_EXCEPTION', {
    action: 'sendTransaction', data: null, reason: null, invocation: null, revert: null,
    transaction: { to: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9', data: '' },
    receipt: receipt as any,
  })
}

describe('mentions429', () => {
  it('sees an HTTP 429 response', () => {
    const req = new FetchRequest('http://127.0.0.1:1/')
    let err: any
    try { new FetchResponse(429, 'Too Many Requests', {}, null, req).assertOk() } catch (e) { err = e }
    expect(err?.code).to.equal('SERVER_ERROR')
    expect(mentions429(err)).to.equal(true)
  })

  it('sees 429 in a plain error message', () => {
    expect(mentions429(new Error('Unexpected server response: 429'))).to.equal(true)
    expect(mentions429(new Error('429 Too Many Requests'))).to.equal(true)
  })

  it('ignores 429 inside a reverted tx receipt', () => {
    for (const receipt of [
      { hash: '0x9f0e429ab1', status: 0 },  // inside hex
      { blockNumber: 429, status: 0 },      // a field that is exactly 429
      { gasUsed: '59429', status: 0 },      // inside a longer number
    ]) {
      const err = revertWith(receipt)
      expect(err.message, JSON.stringify(receipt)).to.include('429')
      expect(mentions429(err), JSON.stringify(receipt)).to.equal(false)
    }
  })

  it('needs 429 to stand alone in a plain message', () => {
    expect(mentions429(new Error('nonce 14290 too low'))).to.equal(false)
    expect(mentions429(new Error('0xab429cd'))).to.equal(false)
  })

  it('handles errors without a message', () => {
    expect(mentions429(undefined)).to.equal(false)
    expect(mentions429({})).to.equal(false)
  })
})
