import { expect } from 'chai'
import { computePollRange, seedPollCursor } from '../../src/services/RawEventsGatherer/listenForRawEvents'

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

// After the historical scan the poll should start from the head the scan
// reached, not from the last event it found. On a chain with no recent
// events those differ by everything since that event.
describe('seedPollCursor', () => {
  it('starts one block below the scanned head when no event is recent', () => {
    // last event at 48,421,811, scan reached 48,544,793: the old cursor sat
    // at the event and re-read ~123k blocks in poll chunks.
    expect(seedPollCursor(48_421_811, 48_421_811, 48_544_793, 1)).to.equal(48_544_792)
  })

  it('works with no event found in the scanned range', () => {
    expect(seedPollCursor(null, 1000, 5000, 1)).to.equal(4999)
  })

  it('never goes below the last event found', () => {
    expect(seedPollCursor(5000, 1000, 5000, 1)).to.equal(5000)
    expect(seedPollCursor(5000, 1000, 4000, 1)).to.equal(5000)
  })

  it('never goes below startBlock when the scan did not run', () => {
    // startBlock > latest: the scan is skipped and scannedHead stays at startBlock.
    expect(seedPollCursor(null, 1000, 1000, 1)).to.equal(1000)
    expect(seedPollCursor(null, 1000, 1000, 5)).to.equal(1000)
  })

  it('applies the configured head margin, as computePollRange does', () => {
    expect(seedPollCursor(null, 0, 1000, 0)).to.equal(1000)
    expect(seedPollCursor(null, 0, 1000, 3)).to.equal(997)
  })

  it('leaves nothing for the first poll when already at the head', () => {
    const cursor = seedPollCursor(null, 0, 1000, 1)
    // The scan reached 1000; the first poll sees head 1000 - 1 = 999 and has
    // nothing to fetch until the chain moves.
    expect(computePollRange(1000, cursor, 1, 1500)).to.equal(null)
    expect(computePollRange(1002, cursor, 1, 1500)).to.deep.equal({ head: 1001, toBlock: 1001 })
  })
})
