/**
 * Hardhat fork test: real SP1 verification against the canonical Base
 * Sepolia bytecode at 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B.
 *
 * Why the separate test-fork/ directory: our normal test/ runs under
 * truffle (which doesn't fork RPCs cleanly). This file runs under
 * hardhat with `npx hardhat test test-fork/zk-fork-test.js`.
 *
 * Prereq: FORK_BASE_SEPOLIA_RPC_URL set in .env (or pass L2_RPC_URL).
 * If neither is set, the test self-skips so CI without RPC creds passes.
 *
 * What this proves vs the existing test/zk-real-verifier-test.js:
 *   - test/zk-real-verifier-test.js — deploys our locally-compiled SP1Verifier
 *     v6.1.0 source (vendored under contracts/sp1-vendor/) and verifies
 *     against THAT bytecode. Equivalent contract; potentially different
 *     bytecode (compiler settings, version pin).
 *   - this fork test — calls the EXACT bytecode that's already running on
 *     Base Sepolia today, sitting at 0x397A5f… It's the SP1VerifierGateway
 *     which routes to versioned verifiers based on the first 4 bytes of
 *     proofBytes. This is what production CawActions will actually call.
 *
 * Skips silently when:
 *   - FORK_BASE_SEPOLIA_RPC_URL / L2_RPC_URL is unset
 *   - solidity/test/zk-fixtures/groth16-fixture.json is absent
 */
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')
const { ethers } = require('ethers')
const { expect } = require('chai')

// Hardhat exposes its in-memory chain over JSON-RPC via hre.network.provider.
// Wrap it in an ethers v6 BrowserProvider so we get the familiar ethers API
// without needing @nomicfoundation/hardhat-ethers.
const provider = new ethers.BrowserProvider(hre.network.provider)

const SP1_GATEWAY = '0x397A5f7f3dBd538f23DE225B51f532c34448dA9B'
const SP1_GATEWAY_ABI = [
  'function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view',
]

const FIXTURE_PATH = path.join(__dirname, '..', 'test', 'zk-fixtures', 'groth16-fixture.json')
let fixture = null
try { fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) } catch {}

const forkConfigured = !!(
  process.env.FORK_BASE_SEPOLIA_RPC_URL ||
  process.env.RPC_BASE_SEPOLIA ||
  process.env.L2_RPC_URL
)
const skipReason = !forkConfigured
  ? 'fork RPC not configured (set FORK_BASE_SEPOLIA_RPC_URL or L2_RPC_URL)'
  : !fixture
  ? 'fixture missing — run cargo run --release --bin evm in solidity/zk/sig-recovery/script first'
  : null

const maybeDescribe = skipReason ? describe.skip : describe

maybeDescribe('Base Sepolia fork — canonical SP1Verifier bytecode', function () {
  this.timeout(180_000)

  before(async () => {
    if (skipReason) console.log(`(skipping fork tests: ${skipReason})`)
    // Sanity: confirm we're on the fork.
    const code = await provider.getCode(SP1_GATEWAY)
    if (code === '0x' || code === '0x0') {
      throw new Error(
        `No bytecode at ${SP1_GATEWAY} on the forked chain. The fork URL ` +
        `must point at Base Sepolia. Got chainId ${(await provider.getNetwork()).chainId}`
      )
    }
  })

  // Helper: gateway.verifyProof is `external view`, returns nothing, reverts
  // on failure. ethers' BrowserProvider mis-handles void returns from forked
  // chains (treats `0x` empty success as "missing revert data" — bug in v6).
  // Workaround: call eth_call directly through hardhat's RPC interface and
  // inspect the raw result so we can distinguish:
  //   - success (result === "0x")
  //   - revert (result has data, or RPC error)
  const verifierIface = new ethers.Interface(SP1_GATEWAY_ABI)
  async function rawEthCall(vkey, publicValues, proof) {
    const data = verifierIface.encodeFunctionData('verifyProof', [vkey, publicValues, proof])
    try {
      const result = await hre.network.provider.send('eth_call', [
        { to: SP1_GATEWAY, data }, 'latest',
      ])
      return { ok: true, result }
    } catch (e) {
      return { ok: false, error: e }
    }
  }

  it('canonical gateway accepts our fixture proof', async () => {
    // The gateway routes based on the first 4 bytes of proofBytes (the
    // verifier selector). Our fixture's proof starts with 0x4388a21c which
    // identifies a registered Groth16 verifier version on Base Sepolia.
    // Empty `0x` return == verifyProof completed without reverting.
    const r = await rawEthCall(fixture.vkey, fixture.publicValues, fixture.proof)
    if (!r.ok) console.log('  raw error:', r.error?.message || r.error)
    expect(r.ok, 'eth_call should not error').to.equal(true)
    expect(r.result, 'verifyProof returns void on success').to.equal('0x')
  })

  it('rejects a tampered proof', async () => {
    // Flip a byte deep in the proof (past the 4-byte selector + 32-byte
    // verifier hash padding). Position ~80 lands inside the actual Groth16
    // pi_a/pi_b/pi_c points where any single-byte change forces a failure.
    const buf = Buffer.from(fixture.proof.slice(2), 'hex')
    buf[80] ^= 0xff
    const tampered = '0x' + buf.toString('hex')
    const r = await rawEthCall(fixture.vkey, fixture.publicValues, tampered)
    expect(r.ok, 'tampered proof should produce an RPC error').to.equal(false)
  })

  it('reports gas cost of canonical verifyProof', async () => {
    // Use estimateGas as the standalone-call cost. The full
    // processActionsWithZkSigs path adds the state-application overhead
    // measured in test/zk-gas-compare-test.js.
    const verifierAbi = [
      'function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view',
    ]
    const iface = new ethers.Interface(verifierAbi)
    const data = iface.encodeFunctionData('verifyProof', [fixture.vkey, fixture.publicValues, fixture.proof])
    const gas = await provider.estimateGas({ to: SP1_GATEWAY, data })
    console.log(`        SP1VerifierGateway.verifyProof gas: ${gas.toString()}`)
    // Sanity bounds — Groth16 on bn254 plus selector dispatch should sit in
    // the 200K–500K range.
    expect(Number(gas)).to.be.greaterThan(150_000)
    expect(Number(gas)).to.be.lessThan(800_000)
  })
})
