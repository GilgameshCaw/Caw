const CawActionsArchiveOptimistic = artifacts.require("CawActionsArchiveOptimistic");
const CawChallengeRelay = artifacts.require("CawChallengeRelay");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const LzReceiveHelper = artifacts.require("LzReceiveHelper");
const { expectRevert, time } = require('@openzeppelin/test-helpers');
const truffleAssert = require('truffle-assertions');
const { MerkleTree } = require('merkletreejs');
const { keccak256 } = require('ethereumjs-util');

// Build a merkle tree matching OZ's MerkleProof.verify with double-hash leaves.
// OZ uses: leaf = keccak256(bytes.concat(keccak256(abi.encode(data))))
// MerkleTree.js with sortPairs + keccak256 hash matches OZ's sorted-pair behavior.
function buildMerkleTree(checkpointIds, checkpointHashes) {
  // Double-hashed leaves to match the Solidity contract:
  // keccak256(bytes.concat(keccak256(abi.encode(checkpointId, checkpointHash))))
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

// Build minimal packed actions for N actions (32 per checkpoint)
function buildPackedActions(actionCount) {
  const buf = Buffer.alloc(2 + actionCount * 25); // header + 25 bytes per minimal action
  buf.writeUInt16BE(actionCount, 0);
  for (let i = 0; i < actionCount; i++) {
    const off = 2 + i * 25;
    buf.writeUInt8(0, off);         // actionType = CAW
    buf.writeUInt32BE(1, off + 1);  // senderId
    buf.writeUInt32BE(0, off + 5);  // receiverId
    buf.writeUInt32BE(0, off + 9);  // receiverCawonce
    buf.writeUInt32BE(1, off + 13); // clientId
    buf.writeUInt32BE(i, off + 17); // cawonce
    buf.writeUInt8(0, off + 21);    // recipientCount
    buf.writeUInt8(0, off + 22);    // amountCount
    buf.writeUInt16BE(0, off + 23); // textLength
  }
  return '0x' + buf.toString('hex');
}

// Build r values (just random bytes32 for testing)
function buildRValues(count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(web3.utils.soliditySha3({ type: 'uint256', value: i + 1000 }));
  }
  return values;
}

contract("CawActionsArchiveOptimistic", function(accounts) {
  const CHECKPOINT_INTERVAL = 32;
  const MIN_STAKE = web3.utils.toWei('0.001', 'ether');
  const CHALLENGE_PERIOD = 2 * 24 * 60 * 60; // 2 days in seconds

  let archive, mockEndpoint, lzHelper;
  let checkpointHashes, merkleRoot, merkleTree, merkleLeaves;
  const L2_EID = 40245; // Base Sepolia (source chain for challenges)
  const RELAY_PEER = '0x' + '00'.repeat(12) + 'aabbccddaabbccddaabbccddaabbccddaabbccdd'; // fake relay address as bytes32

  before(async function() {
    // Use the LzReceiveHelper as the endpoint so we can call lzReceive
    lzHelper = await LzReceiveHelper.new();
    archive = await CawActionsArchiveOptimistic.new(lzHelper.address);
    // Set peer for challenges (simulating CawChallengeRelay on L2)
    await archive.setPeer(L2_EID, RELAY_PEER);

    // Build test data: 2 checkpoints = 64 actions
    const numCheckpoints = 2;
    checkpointHashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'checkpoint1' }),
      web3.utils.soliditySha3({ type: 'string', value: 'checkpoint2' }),
    ];

    const result = buildMerkleTree([1, 2], checkpointHashes);
    merkleTree = result.tree;
    merkleLeaves = result.leaves;
    merkleRoot = '0x' + merkleTree.getRoot().toString('hex');
  });

  it("should accept a valid submission with sufficient stake", async function() {
    const packedActions = buildPackedActions(64);
    const rValues = buildRValues(64);

    const tx = await archive.submitReplication(1, 1, 2, packedActions, rValues, merkleRoot, {
      from: accounts[0],
      value: MIN_STAKE,
    });

    truffleAssert.eventEmitted(tx, 'SubmissionCreated', (args) => {
      return args.submissionId.toNumber() === 1 &&
        args.submitter === accounts[0] &&
        args.clientId.toNumber() === 1 &&
        args.startCheckpointId.toNumber() === 1 &&
        args.endCheckpointId.toNumber() === 2;
    });

    truffleAssert.eventEmitted(tx, 'ActionsArchived');

    const sub = await archive.getSubmission(1);
    assert.equal(sub.submitter, accounts[0]);
    assert.equal(sub.status.toNumber(), 0); // PENDING
    console.log("Valid submission accepted: PASS");
  });

  it("should reject submission with insufficient stake", async function() {
    const packedActions = buildPackedActions(32);
    const rValues = buildRValues(32);
    const tinyMerkle = web3.utils.soliditySha3({ type: 'string', value: 'test' });

    try {
      await archive.submitReplication(1, 10, 10, packedActions, rValues, tinyMerkle, {
        from: accounts[1],
        value: '1000', // way too low
      });
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Invalid stake"));
    }
    console.log("Insufficient stake rejected: PASS");
  });

  it("should reject submission for already-claimed checkpoints", async function() {
    const packedActions = buildPackedActions(64);
    const rValues = buildRValues(64);

    try {
      await archive.submitReplication(1, 1, 2, packedActions, rValues, merkleRoot, {
        from: accounts[1],
        value: MIN_STAKE,
      });
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Checkpoint already claimed"));
    }
    console.log("Duplicate checkpoint rejected: PASS");
  });

  it("should reject finalization before challenge period ends", async function() {
    try {
      await archive.finalizeSubmission(1);
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Challenge period active"));
    }
    console.log("Early finalization rejected: PASS");
  });

  it("should allow finalization after challenge period", async function() {
    // Fast-forward 2 days + 1 second
    await time.increase(CHALLENGE_PERIOD + 1);

    const tx = await archive.finalizeSubmission(1);
    truffleAssert.eventEmitted(tx, 'SubmissionFinalized', (args) => {
      return args.submissionId.toNumber() === 1;
    });

    const sub = await archive.getSubmission(1);
    assert.equal(sub.status.toNumber(), 1); // FINALIZED
    console.log("Finalization after period: PASS");
  });

  it("should allow submitter to withdraw stake after finalization", async function() {
    const balanceBefore = BigInt(await web3.eth.getBalance(accounts[0]));
    const tx = await archive.withdrawStake(1, { from: accounts[0] });

    truffleAssert.eventEmitted(tx, 'StakeWithdrawn');

    const balanceAfter = BigInt(await web3.eth.getBalance(accounts[0]));
    // Balance should increase (minus gas)
    assert(balanceAfter > balanceBefore - BigInt(web3.utils.toWei('0.01', 'ether')));
    console.log("Stake withdrawal: PASS");
  });

  it("should reject stake withdrawal by non-submitter", async function() {
    // Submit a new one first
    const packedActions = buildPackedActions(32);
    const rValues = buildRValues(32);
    const fakeMerkle = web3.utils.soliditySha3({ type: 'string', value: 'new' });

    await archive.submitReplication(1, 3, 3, packedActions, rValues, fakeMerkle, {
      from: accounts[0],
      value: MIN_STAKE,
    });

    await time.increase(CHALLENGE_PERIOD + 1);
    await archive.finalizeSubmission(2);

    try {
      await archive.withdrawStake(2, { from: accounts[1] });
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Not submitter"));
    }
    console.log("Non-submitter withdrawal rejected: PASS");
  });

  // ============================================
  // CHALLENGE TESTS
  // ============================================

  it("should accept a challenge hash via LZ receive", async function() {
    // Submit a new batch (checkpoints 4-5)
    const packedActions = buildPackedActions(64);
    const rValues = buildRValues(64);
    const badHashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'bad_checkpoint4' }),
      web3.utils.soliditySha3({ type: 'string', value: 'bad_checkpoint5' }),
    ];
    const result = buildMerkleTree([4, 5], badHashes);
    const badRoot = '0x' + result.tree.getRoot().toString('hex');

    await archive.submitReplication(1, 4, 5, packedActions, rValues, badRoot, {
      from: accounts[2],
      value: MIN_STAKE,
    });

    const submissionId = 3; // third submission

    // Simulate LZ delivery of the correct hash
    const correctHash = web3.utils.soliditySha3({ type: 'string', value: 'correct_checkpoint4' });
    const payload = web3.eth.abi.encodeParameters(
      ['uint256', 'uint32', 'uint256', 'bytes32'],
      [submissionId, 1, 4, correctHash]
    );

    // Deliver the challenge via the LzReceiveHelper (which IS the endpoint)
    await lzHelper.deliver(
      archive.address,
      L2_EID,
      RELAY_PEER,
      1, // nonce
      web3.utils.randomHex(32), // guid
      payload
    );

    const delivered = await archive.challengeDelivered(submissionId, 4);
    assert.equal(delivered, true);
    const storedHash = await archive.challengeHash(submissionId, 4);
    assert.equal(storedHash, correctHash);
    console.log("Challenge hash delivered via LZ: PASS");
  });

  it("should slash a fraudulent submission via resolveChallenge", async function() {
    const submissionId = 3;
    const checkpointId = 4;

    // The bad hash that the submitter committed to
    const claimedHash = web3.utils.soliditySha3({ type: 'string', value: 'bad_checkpoint4' });

    // Rebuild the merkle tree for checkpoints 4-5 to get the proof
    const badHashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'bad_checkpoint4' }),
      web3.utils.soliditySha3({ type: 'string', value: 'bad_checkpoint5' }),
    ];
    const result = buildMerkleTree([4, 5], badHashes);
    const proof = getProof(result.tree, result.leaves, 0); // index 0 = checkpoint 4

    const challengerBalanceBefore = BigInt(await web3.eth.getBalance(accounts[3]));

    const tx = await archive.resolveChallenge(submissionId, checkpointId, claimedHash, proof, {
      from: accounts[3],
    });

    truffleAssert.eventEmitted(tx, 'SubmissionSlashed', (args) => {
      return args.submissionId.toNumber() === submissionId &&
        args.challenger === accounts[3] &&
        args.checkpointId.toNumber() === checkpointId;
    });

    const sub = await archive.getSubmission(submissionId);
    assert.equal(sub.status.toNumber(), 2); // SLASHED

    // Checkpoints should be released
    const claimed4 = await archive.checkpointClaimed(1, 4);
    const claimed5 = await archive.checkpointClaimed(1, 5);
    assert.equal(claimed4.toNumber(), 0);
    assert.equal(claimed5.toNumber(), 0);

    console.log("Fraudulent submission slashed: PASS");
  });

  it("should reject resolveChallenge when hashes match (no fraud)", async function() {
    // Submit honest data (checkpoints 4-5 again, since they were released)
    const packedActions = buildPackedActions(64);
    const rValues = buildRValues(64);
    const honestHashes = [
      web3.utils.soliditySha3({ type: 'string', value: 'honest_cp4' }),
      web3.utils.soliditySha3({ type: 'string', value: 'honest_cp5' }),
    ];
    const result = buildMerkleTree([4, 5], honestHashes);
    const honestRoot = '0x' + result.tree.getRoot().toString('hex');

    await archive.submitReplication(1, 4, 5, packedActions, rValues, honestRoot, {
      from: accounts[0],
      value: MIN_STAKE,
    });
    const submissionId = 4;

    // Deliver the SAME hash via LZ (no fraud)
    const correctHash = honestHashes[0]; // matches what submitter claimed
    const payload = web3.eth.abi.encodeParameters(
      ['uint256', 'uint32', 'uint256', 'bytes32'],
      [submissionId, 1, 4, correctHash]
    );

    await lzHelper.deliver(
      archive.address,
      L2_EID,
      RELAY_PEER,
      2, // nonce
      web3.utils.randomHex(32),
      payload
    );

    const proof = getProof(result.tree, result.leaves, 0);

    try {
      await archive.resolveChallenge(submissionId, 4, honestHashes[0], proof, {
        from: accounts[3],
      });
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Hashes match"));
    }
    console.log("False challenge rejected: PASS");
  });

  it("should report range availability correctly", async function() {
    const available = await archive.isRangeAvailable(1, 6, 10);
    assert.equal(available, true);

    const unavailable = await archive.isRangeAvailable(1, 4, 6); // 4-5 are claimed
    assert.equal(unavailable, false);

    console.log("Range availability check: PASS");
  });

  it("should reject action count mismatch", async function() {
    const wrongPackedActions = buildPackedActions(10); // wrong count for 1 checkpoint
    const rValues = buildRValues(32);
    const fakeMerkle = web3.utils.soliditySha3({ type: 'string', value: 'mismatch' });

    try {
      await archive.submitReplication(1, 6, 6, wrongPackedActions, rValues, fakeMerkle, {
        from: accounts[0],
        value: MIN_STAKE,
      });
      assert.fail("Should have reverted");
    } catch (err) {
      assert(err.message.includes("Action count mismatch"));
    }
    console.log("Action count mismatch rejected: PASS");
  });
});
