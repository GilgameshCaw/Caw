import { expect } from 'chai'
import { tipShortfallRejections } from '../../src/utils/tipShortfallRejections'

const SHORT = 'Insufficient tip: 1000 CAW (0.00001614 ETH) < gas cost 0.00002 ETH'

describe('tipShortfallRejections', () => {
  it('gives the shortfall reason only to entries that passed simulation', () => {
    expect(tipShortfallRejections(['', 'Cawonce already used', ''], 3, SHORT))
      .to.deep.equal([SHORT, 'Cawonce already used', SHORT])
  })

  it('keeps every simulation rejection as it was', () => {
    const sim = ['UserNotAuth — sender not authenticated on this Network', 'Cawonce already used']
    expect(tipShortfallRejections(sim, 2, SHORT)).to.deep.equal(sim)
  })

  it('treats a missing simulation entry as passed', () => {
    expect(tipShortfallRejections([''], 2, SHORT)).to.deep.equal([SHORT, SHORT])
  })

  it('returns one reason per entry, never more', () => {
    expect(tipShortfallRejections(['', '', 'x'], 2, SHORT)).to.deep.equal([SHORT, SHORT])
    expect(tipShortfallRejections([], 0, SHORT)).to.deep.equal([])
  })
})
