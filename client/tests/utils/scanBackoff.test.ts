import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ScanBackoff } from '../../src/utils/scanBackoff'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('ScanBackoff', () => {
  it('lets a key that was never recorded scan', () => {
    const b = new ScanBackoff(3_600_000, clock().now)
    expect(b.remaining('1', 20_000_000)).to.equal(0)
  })

  it('holds a recorded key for the hold time and then lets it scan', () => {
    const c = clock()
    const b = new ScanBackoff(3_600_000, c.now)
    b.record('1', 20_000_000)
    expect(b.remaining('1', 20_000_000)).to.equal(3_600_000)
    c.advance(120_000)
    expect(b.remaining('1', 20_000_000)).to.equal(3_480_000)
    c.advance(3_480_000)
    expect(b.remaining('1', 20_000_000)).to.equal(0)
  })

  it('lifts the hold when the limit changes', () => {
    const b = new ScanBackoff(3_600_000, clock().now)
    b.record('1', 20_000_000)
    expect(b.remaining('1', 40_000_000)).to.equal(0)
    // and stays lifted for the old limit: the record is gone
    expect(b.remaining('1', 20_000_000)).to.equal(0)
  })

  it('keeps keys apart', () => {
    const b = new ScanBackoff(3_600_000, clock().now)
    b.record('1', 20_000_000)
    expect(b.remaining('2', 20_000_000)).to.equal(0)
  })

  it('clear releases a key', () => {
    const b = new ScanBackoff(3_600_000, clock().now)
    b.record('1', 20_000_000)
    b.clear('1')
    expect(b.remaining('1', 20_000_000)).to.equal(0)
  })
})
