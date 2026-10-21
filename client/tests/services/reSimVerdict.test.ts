import { expect } from 'chai'
import { isTemporaryRejection, reSimVerdict } from '../../src/utils/reSimVerdict'

// recoverBatchFailure's re-simulation, after a batch tx reverted. The
// rejection strings are the ones simulateActions returns (decodeCustomError's
// table, and the "will retry" markers from its catch branches).
describe('reSimVerdict', () => {
  it('puts an entry the re-sim does not reject back to pending', () => {
    expect(reSimVerdict('')).to.deep.equal({ pending: true })
    expect(reSimVerdict(undefined)).to.deep.equal({ pending: true })
  })

  it('puts a used cawonce back to pending instead of failing it', () => {
    expect(reSimVerdict('CawonceUsed — Cawonce already used')).to.deep.equal({ pending: true })
  })

  for (const r of [
    'RPC timeout - will retry',
    'Network error - will retry',
    'LZ withdraw quote failed (will retry): withdrawQuote timeout after 10s',
  ]) {
    it(`puts a temporary rejection back to pending (${r})`, () => {
      expect(reSimVerdict(r)).to.deep.equal({ pending: true })
    })
  }

  it('fails an entry rejected on its own merits, with the rejection as reason', () => {
    const r = 'InsufficientBalance — not enough staked CAW to cover this action'
    expect(reSimVerdict(r)).to.deep.equal({ succeeded: false, reason: r })
  })

  it('decides each entry of a batch on its own', () => {
    const rejections = [
      'CawonceUsed — Cawonce already used',
      '',
      'InsufficientBalance — not enough staked CAW to cover this action',
      'CawonceUsed — Cawonce already used',
    ]
    expect(rejections.map(reSimVerdict)).to.deep.equal([
      { pending: true },
      { pending: true },
      { succeeded: false, reason: rejections[2] },
      { pending: true },
    ])
  })
})

// The main simulation path's list, moved here unchanged.
describe('isTemporaryRejection', () => {
  for (const m of [
    'RPC call timeout after 30 seconds',
    'Network error - will retry',
    'connection reset',
    'rpc unavailable',
    'LZ withdraw quote failed (will retry): x',
    'Too Many Requests',
    'HTTP 429',
    'rate limit exceeded',
    'missing response',
    'Sender not authenticated with this client',
    'Session expired or not found',
  ]) {
    it(`matches "${m}"`, () => {
      expect(isTemporaryRejection(m)).to.equal(true)
    })
  }

  it('does not match a permanent rejection or an empty one', () => {
    expect(isTemporaryRejection('CawonceUsed — Cawonce already used')).to.equal(false)
    expect(isTemporaryRejection('InsufficientBalance — not enough staked CAW to cover this action')).to.equal(false)
    expect(isTemporaryRejection('')).to.equal(false)
    expect(isTemporaryRejection(undefined)).to.equal(false)
  })
})
