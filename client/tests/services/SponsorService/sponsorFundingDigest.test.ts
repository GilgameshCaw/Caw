/**
 * The sponsor server must sign exactly the digest CawProfileMinter checks in
 * _sponsoredFunder, or every sponsored bootstrap reverts FunderConsentMissing.
 *
 * Expected value comes from CawProfileMinter.sponsorFundingDigest(0x…1111) in
 * the Foundry fixture (PopBBootstrapE2ETest: chainid 31337, minter at
 * 0x1d1499e622D69689cdf9004d05Ec547d650Ff211).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { Wallet, recoverAddress, zeroPadValue, toBeHex } from 'ethers'
import { sponsorFundingDigest } from '../../../src/services/SponsorService'

const CHAIN_ID = 31337
const MINTER = '0x1d1499e622D69689cdf9004d05Ec547d650Ff211'
const PERMIT_DIGEST = zeroPadValue(toBeHex(0x1111), 32)
const CONTRACT_DIGEST = '0xefbd263d81a4cf86dca8e07b1f5f03ef99d1aadc07c01f5ffaaae1ada5602b29'

describe('sponsorFundingDigest (server ↔ CawProfileMinter)', () => {
  it('matches the digest the Minter computes', () => {
    expect(sponsorFundingDigest(CHAIN_ID, MINTER, PERMIT_DIGEST)).to.equal(CONTRACT_DIGEST)
  })

  it('a raw signingKey signature over it recovers to the sponsor wallet', () => {
    const w = Wallet.createRandom()
    const digest = sponsorFundingDigest(CHAIN_ID, MINTER, PERMIT_DIGEST)
    const sig = w.signingKey.sign(digest)
    expect(recoverAddress(digest, sig)).to.equal(w.address)
    // 65 bytes r||s||v with v in {27, 28}, as _recoverFunder expects.
    expect((sig.serialized.length - 2) / 2).to.equal(65)
    expect([27, 28]).to.include(sig.v)
  })

  it('changes with the permit digest (consent is per permit)', () => {
    const other = zeroPadValue(toBeHex(0x2222), 32)
    expect(sponsorFundingDigest(CHAIN_ID, MINTER, other)).to.not.equal(CONTRACT_DIGEST)
  })
})
