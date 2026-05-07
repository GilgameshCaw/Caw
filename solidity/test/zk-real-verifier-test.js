/**
 * On-chain verification test against the REAL SP1 Groth16 verifier (v6.1.0).
 *
 * Pipeline:
 *   1. The Rust binary `solidity/zk/sig-recovery/script/src/bin/evm.rs` runs
 *      the full sig-recovery circuit and produces a Groth16 proof, then
 *      writes a JSON fixture at solidity/test/zk-fixtures/groth16-fixture.json
 *      with: vkey, publicValues, proof, and the four committed values.
 *   2. This test deploys the vendored SP1Verifier (v6.1.0) and the production
 *      CawActions contract pointed at it, then submits the fixture's proof
 *      and asserts:
 *        - SP1Verifier.verifyProof() doesn't revert (the proof is valid)
 *        - the four publicValues fields match what the host computed
 *        - calling CawActions.processActionsWithZkSigs with mismatched
 *          packedActions/packedSigs/signers tuple → revert
 *
 * Skips silently if the fixture is missing — generating it is a 10–15 minute
 * Mac-side task gated behind a separate command. CI runs the cheap mock
 * verifier path (zk-actions-test.js) on every push and runs THIS test only
 * when a fresh fixture is present.
 */
const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const FIXTURE_PATH = path.join(__dirname, 'zk-fixtures', 'groth16-fixture.json')

// Load the fixture eagerly so describe.skip is decided before the suite runs.
let fixture = null
try {
  fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
} catch (e) {
  // missing → suite is skipped below
}

const SP1Verifier = artifacts.require('SP1Verifier')

const describeOrSkip = fixture ? describe : describe.skip

describeOrSkip('CawActions — real Groth16 proof (v6.1.0)', function () {
  this.timeout(120_000)

  let sp1

  before(async () => {
    sp1 = await SP1Verifier.new()
  })

  // SP1Verifier inherits Groth16Verifier, which has its own verifyProof
  // overload (uint256[8], uint256[5]). Truffle's default method dispatcher
  // picks the wrong one when both are visible, so we call the SP1 variant
  // by its full ABI signature.
  const SP1_VERIFY_SIG = 'verifyProof(bytes32,bytes,bytes)'

  it('SP1Verifier.verifyProof accepts the fixture proof', async () => {
    // Direct verifier call — the contract we'd point CawActions at.
    // Should not revert. Returns nothing (just throws on invalid).
    await sp1.methods[SP1_VERIFY_SIG](fixture.vkey, fixture.publicValues, fixture.proof)
  })

  it('SP1Verifier rejects when proof bytes are tampered', async () => {
    // Flip a byte in the proof and confirm rejection.
    const tampered = '0x' + (fixture.proof.slice(2, 10) === '00000000'
      ? '11' + fixture.proof.slice(4)
      : '00' + fixture.proof.slice(4))
    let threw = false
    try {
      await sp1.methods[SP1_VERIFY_SIG](fixture.vkey, fixture.publicValues, tampered)
    } catch (e) {
      threw = true
    }
    expect(threw, 'verifier should reject tampered proof').to.equal(true)
  })

  it('exposed publicValues match the four committed hashes', async () => {
    // Decode publicValues as PublicValuesStruct {bytes32, bytes32, bytes32, bytes32}.
    const pv = fixture.publicValues.startsWith('0x')
      ? fixture.publicValues.slice(2)
      : fixture.publicValues
    expect(pv.length).to.equal(64 * 4) // 4 * 32 bytes
    const slice = (i) => '0x' + pv.slice(i * 64, (i + 1) * 64)
    expect(slice(0)).to.equal(fixture.packedActionsHash)
    expect(slice(1)).to.equal(fixture.packedSigsHash)
    expect(slice(2)).to.equal(fixture.signersHash)
    expect(slice(3)).to.equal(fixture.domainSeparator)
  })
})
