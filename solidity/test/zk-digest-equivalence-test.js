/**
 * Equivalence test: every EIP-712 digest the Rust circuit computes for an
 * ActionData input must match the on-chain Solidity `_computeStructHash` /
 * full digest byte-for-byte.
 *
 * Why this is the load-bearing safety net: the digest math is the seam
 * between the off-chain proof and the on-chain verifier. If the circuit
 * computes a digest the contract wouldn't have, EVERY proof fails (or
 * worse — succeeds against a maliciously-crafted alternate input). One
 * stale comma in a typehash string, one wrong padding direction, one
 * field reordering, and the whole ZK path is silently broken.
 *
 * Flow:
 *   1. Deploy CawActionsDigestExposer (test-only contract that exposes
 *      _computeStructHash and the full EIP-712 digest as public views).
 *   2. Read the deployed helper's `eip712DomainHash`. This depends on
 *      chainId + the helper's deployed address — i.e. it changes per run.
 *   3. Shell out to the Rust binary `digest-fixtures`, passing the
 *      just-read domain, to regenerate fixtures keyed to THIS deployment.
 *   4. For each fixture, call the helper's exposed views and assert
 *      byte-for-byte equality with the Rust-computed values.
 *
 * The test takes ~30s on first run because of the Rust release rebuild;
 * subsequent runs reuse the cached binary and the on-chain part is fast.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CawActionsDigestExposer = artifacts.require("CawActionsDigestExposer");
const CawProfileLedger = artifacts.require("CawProfileLedger");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");

const { linkSessionMessageParser } = require('./helpers/link-libraries');

const FIXTURE_PATH = path.join(__dirname, 'zk-digest-fixtures.json');
const SCRIPT_DIR = path.join(__dirname, '..', 'zk', 'sig-recovery', 'script');
const FIXTURE_COUNT = process.env.ZK_DIGEST_FIXTURES_COUNT
  ? parseInt(process.env.ZK_DIGEST_FIXTURES_COUNT, 10)
  : 50; // 50 covers the structural edge cases + ~44 random shapes; bump via env

const l1 = 30101;
const l2 = 8453;

contract('ZK digest equivalence — Rust circuit ↔ Solidity _computeStructHash', function (accounts) {

  let exposer;
  let fixtureFile;

  before(async function () {
    this.timeout(300000); // includes Rust release rebuild on first run

    // Deploy a CawProfileLedger stub (CawActions ctor needs it). We never call
    // anything on it — just need a non-zero address that ownerOf can return
    // 0x0 from for non-existent token IDs (which is what we want for digest-
    // only tests; signature verification isn't exercised here).
    const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    await linkSessionMessageParser();
    const cawProfileLedger = await CawProfileLedger.new(l1, l2Endpoint.address, "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000bEEF", "0x000000000000000000000000000000000000dEAD", "0x000000000000000000000000000000000000cAFE", false, accounts[0]);
    exposer = await CawActionsDigestExposer.new(cawProfileLedger.address);

    // The helper's domain hash is keyed to its address + chainId, so it
    // changes every run. Regenerate fixtures with that exact domain so the
    // EIP-712 digest comparison is meaningful.
    const onchainDomain = await exposer.eip712DomainHash();
    console.log(`[zk-digest-equiv] helper deployed at ${exposer.address}`);
    console.log(`[zk-digest-equiv] eip712DomainHash = ${onchainDomain}`);
    console.log(`[zk-digest-equiv] regenerating ${FIXTURE_COUNT} fixtures via Rust...`);

    const env = {
      ...process.env,
      PATH: `${process.env.HOME}/.sp1/bin:/opt/homebrew/bin:${process.env.PATH || ''}`,
      LIBCLANG_PATH: '/Library/Developer/CommandLineTools/usr/lib',
    };
    execSync(
      `cargo run --release --bin digest-fixtures -- ` +
      `--count ${FIXTURE_COUNT} --domain ${onchainDomain} --out ${FIXTURE_PATH}`,
      { cwd: SCRIPT_DIR, env, stdio: 'inherit' }
    );

    fixtureFile = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    if (fixtureFile.domain.toLowerCase() !== onchainDomain.toLowerCase()) {
      throw new Error(
        `Fixture regen produced wrong domain. Got ${fixtureFile.domain}, ` +
        `expected ${onchainDomain}.`
      );
    }
  });

  it(`every Rust-computed struct hash matches Solidity _computeStructHash`, async function () {
    this.timeout(600000); // 50+ on-chain calls per run

    const total = fixtureFile.fixtures.length;
    expect(total, 'fixture file has zero entries').to.be.greaterThan(0);

    for (let i = 0; i < total; i++) {
      const f = fixtureFile.fixtures[i];

      // ABI-encode the ActionData struct exactly the way Solidity expects.
      // Numeric fields stay decimal; arrays are arrays-of-decimals; text is
      // a 0x-prefixed hex string (bytes).
      const action = {
        actionType:      f.action_type,
        senderId:        f.sender_id,
        receiverId:      f.receiver_id,
        receiverCawonce: f.receiver_cawonce,
        networkId:        f.network_id,
        cawonce:         f.cawonce,
        recipients:      f.recipients,
        // truffle's web3 wants strings for uint64 to avoid JS-precision loss;
        // we already store them that way in the fixture.
        amounts:         f.amounts,
        text:            f.text_hex,
      };

      const onchainStructHash = await exposer.exposeComputeStructHash(action);
      const onchainDigest     = await exposer.exposeEip712Digest(action);

      if (onchainStructHash.toLowerCase() !== f.expected_struct_hash.toLowerCase()) {
        throw new Error(
          `Fixture #${i} struct-hash mismatch.\n` +
          `  Rust: ${f.expected_struct_hash}\n` +
          `  Solidity: ${onchainStructHash}\n` +
          `  Action: ${JSON.stringify(action)}`
        );
      }
      if (onchainDigest.toLowerCase() !== f.expected_eip712_digest.toLowerCase()) {
        throw new Error(
          `Fixture #${i} EIP-712 digest mismatch.\n` +
          `  Rust: ${f.expected_eip712_digest}\n` +
          `  Solidity: ${onchainDigest}\n` +
          `  Action: ${JSON.stringify(action)}`
        );
      }
    }

    console.log(`✅ ${total} digest pairs match byte-for-byte.`);
  });
});
