const CawNetworkManager = artifacts.require("CawNetworkManager");
const truffleAssert = require('truffle-assertions');

contract("CawNetworkManager - feeCeiling", (accounts) => {
  let networkManager;
  const owner = accounts[0];
  const nonOwner = accounts[1];
  const buyAndBurn = accounts[9];

  const l2Eid = 40245; // Base Sepolia

  // Helper: wei values used across tests
  const toWei = (n) => web3.utils.toWei(String(n), 'ether');

  beforeEach(async () => {
    networkManager = await CawNetworkManager.new(buyAndBurn, { from: owner });
  });

  // ======================================================
  // createNetwork ceiling enforcement
  // ======================================================

  it("1. createNetwork succeeds when each fee == ceiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork(
      "Exact Ceiling", owner, l2Eid,
      ceiling, ceiling, ceiling, ceiling,
      ceiling,
      { from: owner }
    );
    assert.equal((await networkManager.getFeeCeiling(1)).toString(), ceiling);
  });

  it("2a. createNetwork reverts when withdrawFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    const over    = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, over, 0, 0, 0, ceiling, { from: owner }),
      "withdrawFee exceeds ceiling"
    );
  });

  it("2b. createNetwork reverts when depositFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    const over    = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, 0, over, 0, 0, ceiling, { from: owner }),
      "depositFee exceeds ceiling"
    );
  });

  it("2c. createNetwork reverts when authFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    const over    = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, 0, 0, over, 0, ceiling, { from: owner }),
      "authFee exceeds ceiling"
    );
  });

  it("2d. createNetwork reverts when mintFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    const over    = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, 0, 0, 0, over, ceiling, { from: owner }),
      "mintFee exceeds ceiling"
    );
  });

  it("3. createNetwork with feeCeiling=0 and all fees=0 succeeds (permanently-free network)", async () => {
    await networkManager.createNetwork("Free", owner, l2Eid, 0, 0, 0, 0, 0, { from: owner });
    assert.equal((await networkManager.getFeeCeiling(1)).toString(), '0');
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), '0');
  });

  it("4a. createNetwork with feeCeiling=0 and withdrawFee>0 reverts", async () => {
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, 1, 0, 0, 0, 0, { from: owner }),
      "withdrawFee exceeds ceiling"
    );
  });

  it("4b. createNetwork with feeCeiling=0 and depositFee>0 reverts", async () => {
    await truffleAssert.reverts(
      networkManager.createNetwork("Bad", owner, l2Eid, 0, 1, 0, 0, 0, { from: owner }),
      "depositFee exceeds ceiling"
    );
  });

  // ======================================================
  // setWithdrawFee ceiling enforcement
  // ======================================================

  it("5. setWithdrawFee above ceiling reverts", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    const over = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.setWithdrawFee(1, over, { from: owner }),
      "exceeds fee ceiling"
    );
  });

  it("6. setWithdrawFee == ceiling succeeds", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await networkManager.setWithdrawFee(1, ceiling, { from: owner });
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), ceiling);
  });

  // ======================================================
  // setFees ceiling enforcement
  // ======================================================

  it("7a. setFees reverts when withdrawFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, toWei('0.02'), 0, 0, 0, { from: owner }),
      "exceeds fee ceiling"
    );
  });

  it("7b. setFees reverts when depositFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, toWei('0.02'), 0, 0, { from: owner }),
      "exceeds fee ceiling"
    );
  });

  it("7c. setFees reverts when authFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, 0, toWei('0.02'), 0, { from: owner }),
      "exceeds fee ceiling"
    );
  });

  it("7d. setFees reverts when mintFee > ceiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, 0, 0, toWei('0.02'), { from: owner }),
      "exceeds fee ceiling"
    );
  });

  it("8. setFees with all fees == ceiling succeeds", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await networkManager.setFees(1, ceiling, ceiling, ceiling, ceiling, { from: owner });
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), ceiling);
    assert.equal((await networkManager.getDepositFee(1)).toString(), ceiling);
    assert.equal((await networkManager.getAuthFee(1)).toString(), ceiling);
    assert.equal((await networkManager.getMintFee(1)).toString(), ceiling);
  });

  // ======================================================
  // lowerFeeCeiling
  // ======================================================

  it("9. lowerFeeCeiling to valid lower value succeeds and emits event", async () => {
    const ceiling = toWei('0.10');
    const fee     = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, fee, fee, fee, fee, ceiling, { from: owner });

    const newCeiling = toWei('0.05');
    const tx = await networkManager.lowerFeeCeiling(1, newCeiling, { from: owner });

    truffleAssert.eventEmitted(tx, 'FeeCeilingLowered', (ev) => {
      return ev.networkId.toNumber() === 1 &&
             ev.oldCeiling.toString() === ceiling &&
             ev.newCeiling.toString() === newCeiling;
    });

    assert.equal((await networkManager.getFeeCeiling(1)).toString(), newCeiling);
  });

  it("10. lowerFeeCeiling to == current ceiling reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, ceiling, { from: owner }),
      "must be lower"
    );
  });

  it("11. lowerFeeCeiling to > current ceiling reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.20'), { from: owner }),
      "must be lower"
    );
  });

  it("12a. lowerFeeCeiling below withdrawFee reverts", async () => {
    const ceiling = toWei('0.10');
    const fee     = toWei('0.05');
    await networkManager.createNetwork("Net", owner, l2Eid, fee, 0, 0, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below withdrawFee"
    );
  });

  it("12b. lowerFeeCeiling below depositFee reverts", async () => {
    const ceiling = toWei('0.10');
    const fee     = toWei('0.05');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, fee, 0, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below depositFee"
    );
  });

  it("12c. lowerFeeCeiling below authFee reverts", async () => {
    const ceiling = toWei('0.10');
    const fee     = toWei('0.05');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, fee, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below authFee"
    );
  });

  it("12d. lowerFeeCeiling below mintFee reverts", async () => {
    const ceiling = toWei('0.10');
    const fee     = toWei('0.05');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, fee, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below mintFee"
    );
  });

  it("13. lowerFeeCeiling called by non-owner reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.05'), { from: nonOwner }),
      "Not the owner"
    );
  });

  it("14. lowerFeeCeiling reverts after fees are locked", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await networkManager.lockNetworkFees(1, { from: owner });

    await truffleAssert.reverts(
      networkManager.lowerFeeCeiling(1, toWei('0.05'), { from: owner }),
      "Fees locked"
    );
  });

  // ======================================================
  // getFeeCeiling reads
  // ======================================================

  it("15a. getFeeCeiling returns the ceiling set at creation", async () => {
    const ceiling = toWei('0.42');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    assert.equal((await networkManager.getFeeCeiling(1)).toString(), ceiling);
  });

  it("15b. getFeeCeiling reflects updated value after lowerFeeCeiling", async () => {
    const ceiling    = toWei('0.10');
    const newCeiling = toWei('0.03');
    await networkManager.createNetwork("Net", owner, l2Eid, 0, 0, 0, 0, ceiling, { from: owner });
    await networkManager.lowerFeeCeiling(1, newCeiling, { from: owner });
    assert.equal((await networkManager.getFeeCeiling(1)).toString(), newCeiling);
  });
});
