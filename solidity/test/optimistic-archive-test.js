const CawActionsArchiveOptimistic = artifacts.require("CawActionsArchiveOptimistic");
const LzReceiveHelper = artifacts.require("LzReceiveHelper");
const { time } = require('@openzeppelin/test-helpers');
const truffleAssert = require('truffle-assertions');
const { MerkleTree } = require('merkletreejs');

// Double-hash leaves to match OZ MerkleProof.verify
function buildMerkleTree(checkpointIds, checkpointHashes) {
  const leaves = checkpointIds.map((id, i) => {
    const inner = web3.eth.abi.encodeParameters(['uint256', 'bytes32'], [id, checkpointHashes[i]]);
    const innerHash = web3.utils.keccak256(inner);
    return web3.utils.keccak256(innerHash);
  });
  const tree = new MerkleTree(
    leaves.map(l => Buffer.from(l.slice(2), 'hex')),
    (buf) => Buffer.from(web3.utils.keccak256('0x' + buf.toString('hex')).slice(2), 'hex'),
    { sortPairs: true, hashLeaves: false }
  );
  return { tree, leaves };
}

function getProof(tree, leaves, index) {
  return tree.getHexProof(Buffer.from(leaves[index].slice(2), 'hex'));
}

function buildPackedActions(actionCount) {
  const buf = Buffer.alloc(2 + actionCount * 25);
  buf.writeUInt16BE(actionCount, 0);
  for (let i = 0; i < actionCount; i++) {
    const off = 2 + i * 25;
    buf.writeUInt8(0, off); buf.writeUInt32BE(1, off + 1); buf.writeUInt32BE(0, off + 5);
    buf.writeUInt32BE(0, off + 9); buf.writeUInt32BE(1, off + 13); buf.writeUInt32BE(i, off + 17);
    buf.writeUInt8(0, off + 21); buf.writeUInt8(0, off + 22); buf.writeUInt16BE(0, off + 23);
  }
  return '0x' + buf.toString('hex');
}

function buildRValues(count) {
  return Array.from({ length: count }, (_, i) =>
    web3.utils.soliditySha3({ type: 'uint256', value: i + 1000 })
  );
}

contract("CawActionsArchiveOptimistic", function(accounts) {
  const MIN_STAKE = web3.utils.toWei('0.01', 'ether');
  const CHALLENGE_PERIOD = 2 * 24 * 60 * 60;
  const L2_EID = 40245;
  const RELAY_PEER = '0x' + '00'.repeat(12) + 'aabbccddaabbccddaabbccddaabbccddaabbccdd';

  let archive, lzHelper;

  before(async function() {
    lzHelper = await LzReceiveHelper.new();
    archive = await CawActionsArchiveOptimistic.new(lzHelper.address);
    await archive.setPeer(L2_EID, RELAY_PEER);
  });

  // ============================================
  // STAKING
  // ============================================

  it("should accept deposits", async function() {
    const tx = await archive.deposit({ from: accounts[0], value: MIN_STAKE });
    truffleAssert.eventEmitted(tx, 'Deposited');
    const stake = await archive.stakes(accounts[0]);
    assert.equal(stake.toString(), MIN_STAKE);
    console.log("Deposit: PASS");
  });

  it("should accept deposits via receive()", async function() {
    await web3.eth.sendTransaction({ from: accounts[1], to: archive.address, value: MIN_STAKE });
    const stake = await archive.stakes(accounts[1]);
    assert.equal(stake.toString(), MIN_STAKE);
    console.log("Deposit via receive(): PASS");
  });

  // ============================================
  // SUBMISSION
  // ============================================

  it("should accept submission from staked validator", async function() {
    const hashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'cp1' }),
      web3.utils.soliditySha3({ type: 'string', value: 'cp2' }),
    ];
    const { tree } = buildMerkleTree([1, 2], hashes);
    const root = '0x' + tree.getRoot().toString('hex');

    const tx = await archive.submitReplication(1, 1, 2, buildPackedActions(64), buildRValues(64), root, {
      from: accounts[0],
    });
    truffleAssert.eventEmitted(tx, 'SubmissionCreated');
    truffleAssert.eventEmitted(tx, 'ActionsArchived');

    const pending = await archive.pendingCount(accounts[0]);
    assert.equal(pending.toNumber(), 1);
    console.log("Submission from staked validator: PASS");
  });

  it("should reject submission from unstaked validator", async function() {
    try {
      await archive.submitReplication(1, 10, 10, buildPackedActions(32), buildRValues(32),
        web3.utils.soliditySha3('x'), { from: accounts[5] });
      assert.fail("Should revert");
    } catch (err) { assert(err.message.includes("Insufficient stake")); }
    console.log("Unstaked submission rejected: PASS");
  });

  it("should reject duplicate checkpoint claims", async function() {
    try {
      await archive.submitReplication(1, 1, 2, buildPackedActions(64), buildRValues(64),
        web3.utils.soliditySha3('y'), { from: accounts[0] });
      assert.fail("Should revert");
    } catch (err) { assert(err.message.includes("Checkpoint already claimed")); }
    console.log("Duplicate claim rejected: PASS");
  });

  // ============================================
  // FINALIZATION
  // ============================================

  it("should reject early finalization", async function() {
    try { await archive.finalizeSubmission(1); assert.fail("Should revert"); }
    catch (err) { assert(err.message.includes("Challenge period active")); }
    console.log("Early finalization rejected: PASS");
  });

  it("should finalize after challenge period", async function() {
    await time.increase(CHALLENGE_PERIOD + 1);
    const tx = await archive.finalizeSubmission(1);
    truffleAssert.eventEmitted(tx, 'SubmissionFinalized');

    const sub = await archive.getSubmission(1);
    assert.equal(sub.status.toNumber(), 1); // FINALIZED

    const pending = await archive.pendingCount(accounts[0]);
    assert.equal(pending.toNumber(), 0);
    console.log("Finalization: PASS");
  });

  // ============================================
  // WITHDRAWAL
  // ============================================

  it("should allow withdrawal with no pending submissions", async function() {
    const balBefore = BigInt(await web3.eth.getBalance(accounts[0]));
    await archive.withdraw(0, { from: accounts[0] }); // 0 = withdraw all
    const stake = await archive.stakes(accounts[0]);
    assert.equal(stake.toString(), '0');
    console.log("Withdrawal: PASS");
  });

  it("should reject withdrawal with pending submissions", async function() {
    // Deposit and submit again
    await archive.deposit({ from: accounts[0], value: MIN_STAKE });
    const hashes = [web3.utils.soliditySha3({ type: 'string', value: 'cp3' })];
    const { tree } = buildMerkleTree([3], hashes);
    const root = '0x' + tree.getRoot().toString('hex');
    await archive.submitReplication(1, 3, 3, buildPackedActions(32), buildRValues(32), root, { from: accounts[0] });

    try { await archive.withdraw(0, { from: accounts[0] }); assert.fail("Should revert"); }
    catch (err) { assert(err.message.includes("Has pending submissions")); }
    console.log("Withdrawal with pending rejected: PASS");

    // Clean up: finalize
    await time.increase(CHALLENGE_PERIOD + 1);
    await archive.finalizeSubmission(2);
  });

  // ============================================
  // CHALLENGE + SLASH
  // ============================================

  it("should slash validator's entire stake on fraud", async function() {
    // accounts[2] stakes and submits bad data
    await archive.deposit({ from: accounts[2], value: web3.utils.toWei('0.05', 'ether') });

    const badHashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'bad4' }),
      web3.utils.soliditySha3({ type: 'string', value: 'bad5' }),
    ];
    const { tree, leaves } = buildMerkleTree([4, 5], badHashes);
    const badRoot = '0x' + tree.getRoot().toString('hex');

    await archive.submitReplication(1, 4, 5, buildPackedActions(64), buildRValues(64), badRoot, { from: accounts[2] });
    const submissionId = (await archive.nextSubmissionId()).toNumber() - 1;

    // Deliver correct hash via LZ
    const correctHash = web3.utils.soliditySha3({ type: 'string', value: 'correct4' });
    const payload = web3.eth.abi.encodeParameters(
      ['uint256', 'uint32', 'uint256', 'bytes32'],
      [submissionId, 1, 4, correctHash]
    );
    await lzHelper.deliver(archive.address, L2_EID, RELAY_PEER, 1, web3.utils.randomHex(32), payload);

    // Resolve: challenger (accounts[3]) gets the full 0.05 ETH stake
    const proof = getProof(tree, leaves, 0);
    const balBefore = BigInt(await web3.eth.getBalance(accounts[3]));

    const tx = await archive.resolveChallenge(submissionId, 4, badHashes[0], proof, { from: accounts[3] });
    truffleAssert.eventEmitted(tx, 'ValidatorSlashed');

    // Validator stake is zero
    const stake = await archive.stakes(accounts[2]);
    assert.equal(stake.toString(), '0');

    // Checkpoints released
    assert.equal((await archive.checkpointClaimed(1, 4)).toNumber(), 0);
    assert.equal((await archive.checkpointClaimed(1, 5)).toNumber(), 0);

    // Challenger received funds
    const balAfter = BigInt(await web3.eth.getBalance(accounts[3]));
    assert(balAfter > balBefore);

    console.log("Full stake slash: PASS");
  });

  it("should invalidate ALL pending submissions on slash", async function() {
    // accounts[4] stakes, submits TWO batches, gets slashed on one
    await archive.deposit({ from: accounts[4], value: web3.utils.toWei('0.03', 'ether') });

    // Batch 1 (honest)
    const h1 = [web3.utils.soliditySha3({ type: 'string', value: 'honest6' })];
    const { tree: t1 } = buildMerkleTree([6], h1);
    await archive.submitReplication(1, 6, 6, buildPackedActions(32), buildRValues(32),
      '0x' + t1.getRoot().toString('hex'), { from: accounts[4] });

    // Batch 2 (bad)
    const h2 = [web3.utils.soliditySha3({ type: 'string', value: 'bad7' })];
    const { tree: t2, leaves: l2 } = buildMerkleTree([7], h2);
    await archive.submitReplication(1, 7, 7, buildPackedActions(32), buildRValues(32),
      '0x' + t2.getRoot().toString('hex'), { from: accounts[4] });
    const badSubId = (await archive.nextSubmissionId()).toNumber() - 1;

    assert.equal((await archive.pendingCount(accounts[4])).toNumber(), 2);

    // Challenge batch 2
    const correctHash = web3.utils.soliditySha3({ type: 'string', value: 'correct7' });
    const payload = web3.eth.abi.encodeParameters(
      ['uint256', 'uint32', 'uint256', 'bytes32'],
      [badSubId, 1, 7, correctHash]
    );
    await lzHelper.deliver(archive.address, L2_EID, RELAY_PEER, 2, web3.utils.randomHex(32), payload);

    const proof = getProof(t2, l2, 0);
    await archive.resolveChallenge(badSubId, 7, h2[0], proof, { from: accounts[3] });

    // BOTH submissions should be slashed
    const sub1 = await archive.getSubmission(badSubId - 1);
    const sub2 = await archive.getSubmission(badSubId);
    assert.equal(sub1.status.toNumber(), 2); // SLASHED
    assert.equal(sub2.status.toNumber(), 2); // SLASHED

    // All checkpoints released
    assert.equal((await archive.checkpointClaimed(1, 6)).toNumber(), 0);
    assert.equal((await archive.checkpointClaimed(1, 7)).toNumber(), 0);

    // Pending count is 0
    assert.equal((await archive.pendingCount(accounts[4])).toNumber(), 0);

    console.log("All pending submissions invalidated on slash: PASS");
  });

  it("should reject false challenge (hashes match)", async function() {
    // accounts[0] re-stakes and submits honest data
    await archive.deposit({ from: accounts[0], value: MIN_STAKE });
    const h = [web3.utils.soliditySha3({ type: 'string', value: 'honest8' })];
    const { tree, leaves } = buildMerkleTree([8], h);
    await archive.submitReplication(1, 8, 8, buildPackedActions(32), buildRValues(32),
      '0x' + tree.getRoot().toString('hex'), { from: accounts[0] });
    const subId = (await archive.nextSubmissionId()).toNumber() - 1;

    // Deliver the SAME hash (no fraud)
    const payload = web3.eth.abi.encodeParameters(
      ['uint256', 'uint32', 'uint256', 'bytes32'],
      [subId, 1, 8, h[0]]
    );
    await lzHelper.deliver(archive.address, L2_EID, RELAY_PEER, 3, web3.utils.randomHex(32), payload);

    const proof = getProof(tree, leaves, 0);
    try {
      await archive.resolveChallenge(subId, 8, h[0], proof, { from: accounts[3] });
      assert.fail("Should revert");
    } catch (err) { assert(err.message.includes("Hashes match")); }
    console.log("False challenge rejected: PASS");
  });

  it("should check range availability", async function() {
    assert.equal(await archive.isRangeAvailable(1, 9, 15), true);
    assert.equal(await archive.isRangeAvailable(1, 8, 9), false); // 8 is claimed
    console.log("Range availability: PASS");
  });
});
