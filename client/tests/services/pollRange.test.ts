import { expect } from 'chai'
import { computePollRange } from '../../src/services/RawEventsGatherer/listenForRawEvents'

// The poll asks getBlockNumber for the head, then getLogs for a range
// ending at it. Under a FallbackProvider those two calls can land on
// different upstreams, so the range is kept a margin below the reported
// head. These cover the arithmetic that does it.
describe('computePollRange', () => {
  const MAX = 1500

  it('polls to headMargin below the reported head', () => {
    const r = computePollRange(1000, 900, 1, MAX)
    expect(r).to.deep.equal({ head: 999, toBlock: 999 })
  })

  it('returns null when the cursor sits inside the margin', () => {
    // Without applying the margin to this comparison too, the caller
    // would build fromBlock=1000, toBlock=999 — an inverted range.
    expect(computePollRange(1000, 999, 1, MAX)).to.equal(null)
  })

  it('returns null when already synced to the adjusted head', () => {
    expect(computePollRange(1000, 1000, 1, MAX)).to.equal(null)
    expect(computePollRange(1000, 1200, 1, MAX)).to.equal(null)
  })

  it('caps the range at maxPollBlocks when far behind', () => {
    const r = computePollRange(1_000_000, 0, 1, MAX)
    expect(r).to.deep.equal({ head: 999_999, toBlock: MAX })
  })

  it('margin 0 reproduces the pre-margin behaviour', () => {
    expect(computePollRange(1000, 999, 0, MAX)).to.deep.equal({ head: 1000, toBlock: 1000 })
  })

  it('honours a wider margin', () => {
    expect(computePollRange(1000, 900, 2, MAX)).to.deep.equal({ head: 998, toBlock: 998 })
    expect(computePollRange(1000, 998, 2, MAX)).to.equal(null)
  })
})
