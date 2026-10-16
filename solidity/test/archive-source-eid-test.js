const CawActionsArchive = artifacts.require("CawActionsArchive");
const LzReceiveHelper = artifacts.require("LzReceiveHelper");
const truffleAssert = require('truffle-assertions');

// The archive is peered with the relay on EVERY other L2 (deploy.js phase 5,
// full mesh), and a network can have its own action stream on more than one of
// them (a token can be authenticated on any L2). So each submission names the
// L2 whose stream it copies, claims are keyed by (sourceEid, networkId), and
// fraud proofs — non-existence and challenge hashes alike — only count when
// they come from that L2's relay. Otherwise a relay on an L2 with no (or a
// different) stream for the network could slash an honest copy.

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

function rpc(method, params) {
  const p = web3.currentProvider;
  if (typeof p.request === 'function') return p.request({ method, params });
  return new Promise((res, rej) => p.send(
    { jsonrpc: '2.0', id: Date.now(), method, params },
    (err, out) => err ? rej(err) : res(out)));
}

function buildRValues(count) {
  return Array.from({ length: count }, (_, i) =>
    web3.utils.soliditySha3({ type: 'uint256', value: i + 1000 })
  );
}

contract("CawActionsArchive — source eid binding", function(accounts) {
  const MIN_STAKE = web3.utils.toWei('0.05', 'ether');
  const NETWORK_ID = 1;
  const HOME_EID = 40245;   // L2 that hosts NETWORK_ID
  const OTHER_EID = 40232;  // another peered L2 that does not
  const HOME_RELAY = '0x' + '00'.repeat(12) + 'aa'.repeat(20);
  const OTHER_RELAY = '0x' + '00'.repeat(12) + 'bb'.repeat(20);
  const ROOT = '0x' + '11'.repeat(32);
  const ZERO32 = '0x' + '00'.repeat(32);
  const attacker = accounts[5];

  let archive, lzHelper, nonce = 0;

  function nonExistence(submissionId, sourceMaxCheckpoint) {
    return web3.eth.abi.encodeParameters(
      ['uint8', 'uint256', 'uint32', 'uint256', 'address'],
      [2, submissionId, NETWORK_ID, sourceMaxCheckpoint, attacker]
    );
  }

  function challenge(submissionId, cpId, hash) {
    return web3.eth.abi.encodeParameters(
      ['uint8', 'uint256', 'uint32', 'uint256[]', 'bytes32[]'],
      [1, submissionId, NETWORK_ID, [cpId], [hash]]
    );
  }

  function deliver(srcEid, peer, payload) {
    nonce += 1;
    return lzHelper.deliver(archive.address, srcEid, peer, nonce, web3.utils.padLeft(web3.utils.toHex(nonce), 64), payload);
  }

  async function submit(validator, cp, sourceEid) {
    await archive.deposit({ from: validator, value: MIN_STAKE });
    const tx = await archive.submitReplication(
      NETWORK_ID, cp, cp, buildPackedActions(32), buildRValues(32), ROOT, ZERO32, sourceEid,
      { from: validator }
    );
    return tx.logs.find(l => l.event === 'SubmissionCreated').args.submissionId;
  }

  before(async function() {
    lzHelper = await LzReceiveHelper.new();
    archive = await CawActionsArchive.new(lzHelper.address, accounts[0]);
    await archive.setPeer(HOME_EID, HOME_RELAY);
    await archive.setPeer(OTHER_EID, OTHER_RELAY);
  });

  it("non-existence from a relay on another L2 does not slash an honest submission", async function() {
    const validator = accounts[1];
    const sid = await submit(validator, 1, HOME_EID);

    // OTHER_EID's CawActions has never seen NETWORK_ID: count 0 -> max cp 0.
    const tx = await deliver(OTHER_EID, OTHER_RELAY, nonExistence(sid, 0));
    await truffleAssert.eventEmitted(
      await truffleAssert.createTransactionResult(archive, tx.tx),
      'ChallengeDropped',
      ev => ev.submissionId.toString() === sid.toString() && ev.reason.toString() === '5'
    );

    assert.equal((await archive.stakes(validator)).toString(), MIN_STAKE);
    assert.equal((await archive.pendingReward(attacker)).toString(), '0');
    assert.equal((await archive.getSubmission(sid)).status.toString(), '0'); // PENDING
  });

  it("non-existence from the source L2 still slashes an over-reaching submission", async function() {
    const validator = accounts[2];
    const sid = await submit(validator, 2, HOME_EID);
    const rewardBefore = await archive.pendingReward(attacker);

    // The home chain really has fewer checkpoints than the submission claims.
    await deliver(HOME_EID, HOME_RELAY, nonExistence(sid, 1));

    assert.equal((await archive.stakes(validator)).toString(), '0');
    const rewardAfter = await archive.pendingReward(attacker);
    assert.equal(rewardAfter.sub(rewardBefore).toString(), MIN_STAKE);
    assert.equal((await archive.getSubmission(sid)).status.toString(), '2'); // SLASHED
  });

  it("a submitter who declares the wrong source eid is slashable from that eid", async function() {
    const validator = accounts[3];
    // Declares OTHER_EID, where NETWORK_ID has no actions at all.
    const sid = await submit(validator, 3, OTHER_EID);
    const rewardBefore = await archive.pendingReward(attacker);

    await deliver(OTHER_EID, OTHER_RELAY, nonExistence(sid, 0));

    assert.equal((await archive.stakes(validator)).toString(), '0');
    const rewardAfter = await archive.pendingReward(attacker);
    assert.equal(rewardAfter.sub(rewardBefore).toString(), MIN_STAKE);
  });

  it("challenge hashes only land from the submission's source L2", async function() {
    const validator = accounts[6];
    const sid = await submit(validator, 5, OTHER_EID);
    const hash = '0x' + '22'.repeat(32);

    // HOME_EID's checkpoint 5 belongs to HOME_EID's stream, not to the one
    // this submission copies.
    const tx = await deliver(HOME_EID, HOME_RELAY, challenge(sid, 5, hash));
    await truffleAssert.eventEmitted(
      await truffleAssert.createTransactionResult(archive, tx.tx),
      'ChallengeDropped',
      ev => ev.submissionId.toString() === sid.toString() && ev.reason.toString() === '5'
    );
    assert.equal(await archive.challengeDelivered(sid, 5), false);

    await deliver(OTHER_EID, OTHER_RELAY, challenge(sid, 5, hash));
    assert.equal(await archive.challengeDelivered(sid, 5), true);
    assert.equal(await archive.challengeHash(sid, 5), hash);
  });

  it("a finalized copy of another L2's stream does not block the source L2's checkpoints", async function() {
    const validator = accounts[7];
    const sid = await submit(validator, 6, OTHER_EID);
    assert.equal((await archive.checkpointClaimed(OTHER_EID, NETWORK_ID, 6)).toString(), sid.toString());
    assert.equal((await archive.checkpointClaimed(HOME_EID, NETWORK_ID, 6)).toString(), '0');

    const period = Number(await archive.CHALLENGE_PERIOD());
    await rpc('evm_increaseTime', [period + 1]);
    await rpc('evm_mine', []);
    await archive.finalizeSubmission(sid);
    assert.equal((await archive.getSubmission(sid)).status.toString(), '1'); // FINALIZED
    assert.equal((await archive.lastFinalizedCheckpoint(OTHER_EID, NETWORK_ID)).toString(), '6');
    assert.equal((await archive.lastFinalizedCheckpoint(HOME_EID, NETWORK_ID)).toString(), '0');

    // Another validator can still replicate HOME_EID's checkpoint 6.
    const homeSid = await submit(accounts[8], 6, HOME_EID);
    assert.equal((await archive.checkpointClaimed(HOME_EID, NETWORK_ID, 6)).toString(), homeSid.toString());

    // But the same stream's checkpoint stays taken.
    await archive.deposit({ from: accounts[9], value: MIN_STAKE });
    try {
      await archive.submitReplication.call(
        NETWORK_ID, 6, 6, buildPackedActions(32), buildRValues(32), ROOT, ZERO32, OTHER_EID,
        { from: accounts[9] }
      );
      assert.fail("Should revert");
    } catch (err) { assert(err.message.includes("Checkpoint already claimed"), err.message); }
  });

  it("rejects a submission whose source eid has no relay peer", async function() {
    const validator = accounts[4];
    await archive.deposit({ from: validator, value: MIN_STAKE });
    try {
      await archive.submitReplication.call(
        NETWORK_ID, 4, 4, buildPackedActions(32), buildRValues(32), ROOT, ZERO32, 40999,
        { from: validator }
      );
      assert.fail("Should revert");
    } catch (err) { assert(err.message.includes("No relay for source eid"), err.message); }
  });
});
