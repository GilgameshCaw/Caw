// MarketplaceIndexer processes one poll window bucket-by-bucket (all
// PayoutQueued, then all PayoutWithdrawn; all BidPlaced, then all
// BidWithdrawn). txHashesAfter lets the withdraw handlers leave out rows
// created by events that come after them on chain in the same window.

import { expect } from 'chai'
import { isAfter, logPosition, txHashesAfter } from '../../../src/services/MarketplaceIndexerService/eventOrder'

const ev = (blockNumber: number, index: number, transactionHash: string, who = 'a') =>
  ({ blockNumber, index, transactionHash, who })

describe('MarketplaceIndexer eventOrder', () => {
  it('orders by block, then by log index', () => {
    expect(isAfter({ blockNumber: 11, index: 0 }, { blockNumber: 10, index: 5 })).to.eq(true)
    expect(isAfter({ blockNumber: 10, index: 6 }, { blockNumber: 10, index: 5 })).to.eq(true)
    expect(isAfter({ blockNumber: 10, index: 5 }, { blockNumber: 10, index: 5 })).to.eq(false)
    expect(isAfter({ blockNumber: 10, index: 4 }, { blockNumber: 10, index: 5 })).to.eq(false)
    expect(isAfter({ blockNumber: 9, index: 9 }, { blockNumber: 10, index: 0 })).to.eq(false)
  })

  it('reads ethers v6 `index` and falls back to `logIndex`', () => {
    expect(logPosition({ blockNumber: 7n, index: 3 })).to.deep.eq({ blockNumber: 7, index: 3 })
    expect(logPosition({ blockNumber: 7, logIndex: 4 })).to.deep.eq({ blockNumber: 7, index: 4 })
  })

  it('withdraw then a new queue in the same window: only the later queue is excluded', () => {
    // PayoutQueued(a) @10:1, PayoutWithdrawn(a) @12:0, PayoutQueued(a) @15:2, PayoutQueued(b) @16:0
    const queued = [ev(10, 1, '0xq1'), ev(15, 2, '0xq2'), ev(16, 0, '0xq3', 'b')]
    const withdrawn = ev(12, 0, '0xw1')
    expect(txHashesAfter(queued, withdrawn, (q) => q.who === 'a')).to.deep.eq(['0xq2'])
  })

  it('same block: later log index is excluded, earlier is kept', () => {
    const queued = [ev(12, 0, '0xbefore'), ev(12, 3, '0xafter')]
    expect(txHashesAfter(queued, ev(12, 1, '0xw'), () => true)).to.deep.eq(['0xafter'])
  })

  it('nothing after the withdraw: empty list (handler keeps its original query)', () => {
    const bids = [ev(10, 0, '0xb1'), ev(11, 0, '0xb2')]
    expect(txHashesAfter(bids, ev(12, 0, '0xw'), () => true)).to.deep.eq([])
  })
})
