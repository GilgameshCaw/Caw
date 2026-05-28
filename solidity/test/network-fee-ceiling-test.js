const CawNetworkManager = artifacts.require("CawNetworkManager");
const truffleAssert = require('truffle-assertions');

contract("CawNetworkManager - per-fee ceilings", (accounts) => {
  let networkManager;
  const owner = accounts[0];
  const nonOwner = accounts[1];
  const buyAndBurn = accounts[2];

  const l2Eid = 40245; // Base Sepolia

  // Helper: wei values used across tests
  const toWei = (n) => web3.utils.toWei(String(n), 'ether');

  beforeEach(async () => {
    networkManager = await CawNetworkManager.new(buyAndBurn, { from: owner });
  });

  // ======================================================
  // createNetwork — initial fee = ceiling
  // ======================================================

  it("1. createNetwork sets each initial fee equal to its ceiling", async () => {
    const wCeil = toWei('0.04');
    const dCeil = toWei('0.03');
    const aCeil = toWei('0.02');
    const mCeil = toWei('0.01');
    await networkManager.createNetwork(
      "Four Ceilings", owner, l2Eid,
      wCeil, dCeil, aCeil, mCeil, "500000000000",
      { from: owner }
    );
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), wCeil, "withdrawFee");
    assert.equal((await networkManager.getDepositFee(1)).toString(), dCeil, "depositFee");
    assert.equal((await networkManager.getAuthFee(1)).toString(), aCeil, "authFee");
    assert.equal((await networkManager.getMintFee(1)).toString(), mCeil, "mintFee");
    assert.equal((await networkManager.getWithdrawFeeCeiling(1)).toString(), wCeil, "withdrawFeeCeiling");
    assert.equal((await networkManager.getDepositFeeCeiling(1)).toString(), dCeil, "depositFeeCeiling");
    assert.equal((await networkManager.getAuthFeeCeiling(1)).toString(), aCeil, "authFeeCeiling");
    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), mCeil, "mintFeeCeiling");
  });

  it("2. createNetwork with all ceilings = 0 (permanently-free network) succeeds", async () => {
    await networkManager.createNetwork("Free", owner, l2Eid, 0, 0, 0, 0, "500000000000", { from: owner });
    assert.equal((await networkManager.getWithdrawFeeCeiling(1)).toString(), '0');
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), '0');
    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), '0');
    assert.equal((await networkManager.getMintFee(1)).toString(), '0');
  });

  it("3. createNetwork with mixed ceilings sets each correctly", async () => {
    // mintFeeCeiling = 0 (forever free mint), others non-zero
    const wCeil = toWei('0.01');
    await networkManager.createNetwork("Mixed", owner, l2Eid, wCeil, wCeil, wCeil, 0, "500000000000", { from: owner });
    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), '0');
    assert.equal((await networkManager.getMintFee(1)).toString(), '0');
    assert.equal((await networkManager.getWithdrawFeeCeiling(1)).toString(), wCeil);
  });

  // ======================================================
  // setWithdrawFee ceiling enforcement
  // ======================================================

  it("4. setWithdrawFee above its ceiling reverts", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    // Lower fee first so we can try to set above ceiling
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    const over = toWei('0.02');
    await truffleAssert.reverts(
      networkManager.setWithdrawFee(1, over, { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("5. setWithdrawFee == ceiling succeeds", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setWithdrawFee(1, ceiling, { from: owner });
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), ceiling);
  });

  it("6. setDepositFee above its ceiling reverts", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setDepositFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.setDepositFee(1, toWei('0.02'), { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("7. setAuthFee above its ceiling reverts", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setAuthFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.setAuthFee(1, toWei('0.02'), { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("8. setMintFee above its ceiling reverts", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setMintFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.setMintFee(1, toWei('0.02'), { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("9. per-fee ceilings are independent: setting one fee above the other's ceiling is fine", async () => {
    // mintCeiling=0, withdrawCeiling=0.1 — can set withdraw high but not mint
    const wCeil = toWei('0.10');
    await networkManager.createNetwork("Indep", owner, l2Eid, wCeil, wCeil, wCeil, 0, "500000000000", { from: owner });
    // Lower withdraw fee first, then set to ceiling — OK
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    await networkManager.setWithdrawFee(1, wCeil, { from: owner });
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), wCeil);
    // Mint fee cannot be set above 0
    await truffleAssert.reverts(
      networkManager.setMintFee(1, 1, { from: owner }),
      "fee exceeds ceiling"
    );
  });

  // ======================================================
  // setFees ceiling enforcement
  // ======================================================

  it("10a. setFees reverts when withdrawFee > withdrawFeeCeiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, toWei('0.02'), 0, 0, 0, { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("10b. setFees reverts when depositFee > depositFeeCeiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, toWei('0.02'), 0, 0, { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("10c. setFees reverts when authFee > authFeeCeiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, 0, toWei('0.02'), 0, { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("10d. setFees reverts when mintFee > mintFeeCeiling", async () => {
    const ceiling = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.setFees(1, 0, 0, 0, toWei('0.02'), { from: owner }),
      "fee exceeds ceiling"
    );
  });

  it("11. setFees with all fees == their individual ceilings succeeds", async () => {
    const wCeil = toWei('0.04');
    const dCeil = toWei('0.03');
    const aCeil = toWei('0.02');
    const mCeil = toWei('0.01');
    await networkManager.createNetwork("Net", owner, l2Eid, wCeil, dCeil, aCeil, mCeil, "500000000000", { from: owner });
    await networkManager.setFees(1, wCeil, dCeil, aCeil, mCeil, "500000000000", { from: owner });
    assert.equal((await networkManager.getWithdrawFee(1)).toString(), wCeil);
    assert.equal((await networkManager.getDepositFee(1)).toString(), dCeil);
    assert.equal((await networkManager.getAuthFee(1)).toString(), aCeil);
    assert.equal((await networkManager.getMintFee(1)).toString(), mCeil);
  });

  // ======================================================
  // lowerWithdrawFeeCeiling
  // ======================================================

  it("12. lowerWithdrawFeeCeiling to valid lower value succeeds and emits event", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    // Lower fee below ceiling first
    await networkManager.setWithdrawFee(1, toWei('0.01'), { from: owner });

    const newCeiling = toWei('0.05');
    const tx = await networkManager.lowerWithdrawFeeCeiling(1, newCeiling, { from: owner });

    truffleAssert.eventEmitted(tx, 'WithdrawFeeCeilingLowered', (ev) => {
      return ev.networkId.toNumber() === 1 &&
             ev.oldCeiling.toString() === ceiling &&
             ev.newCeiling.toString() === newCeiling;
    });

    assert.equal((await networkManager.getWithdrawFeeCeiling(1)).toString(), newCeiling);
  });

  it("13. lowerWithdrawFeeCeiling to == current ceiling reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerWithdrawFeeCeiling(1, ceiling, { from: owner }),
      "must be lower"
    );
  });

  it("14. lowerWithdrawFeeCeiling to > current ceiling reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerWithdrawFeeCeiling(1, toWei('0.20'), { from: owner }),
      "must be lower"
    );
  });

  it("15. lowerWithdrawFeeCeiling below current withdrawFee reverts", async () => {
    const ceiling = toWei('0.10');
    // withdrawFee starts at ceiling (0.10); try to lower ceiling to 0.04
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerWithdrawFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below withdrawFee"
    );
  });

  it("16. lowerWithdrawFeeCeiling does not affect other ceilings", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    await networkManager.lowerWithdrawFeeCeiling(1, toWei('0.05'), { from: owner });
    // deposit/auth/mint ceilings unchanged
    assert.equal((await networkManager.getDepositFeeCeiling(1)).toString(), ceiling);
    assert.equal((await networkManager.getAuthFeeCeiling(1)).toString(), ceiling);
    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), ceiling);
  });

  // ======================================================
  // lowerDepositFeeCeiling
  // ======================================================

  it("17. lowerDepositFeeCeiling succeeds and emits event", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setDepositFee(1, toWei('0.01'), { from: owner });

    const newCeiling = toWei('0.05');
    const tx = await networkManager.lowerDepositFeeCeiling(1, newCeiling, { from: owner });

    truffleAssert.eventEmitted(tx, 'DepositFeeCeilingLowered', (ev) => {
      return ev.networkId.toNumber() === 1 &&
             ev.oldCeiling.toString() === ceiling &&
             ev.newCeiling.toString() === newCeiling;
    });

    assert.equal((await networkManager.getDepositFeeCeiling(1)).toString(), newCeiling);
  });

  it("18. lowerDepositFeeCeiling below depositFee reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerDepositFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below depositFee"
    );
  });

  // ======================================================
  // lowerAuthFeeCeiling
  // ======================================================

  it("19. lowerAuthFeeCeiling succeeds and emits event", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setAuthFee(1, toWei('0.01'), { from: owner });

    const newCeiling = toWei('0.05');
    const tx = await networkManager.lowerAuthFeeCeiling(1, newCeiling, { from: owner });

    truffleAssert.eventEmitted(tx, 'AuthFeeCeilingLowered', (ev) => {
      return ev.networkId.toNumber() === 1 &&
             ev.oldCeiling.toString() === ceiling &&
             ev.newCeiling.toString() === newCeiling;
    });

    assert.equal((await networkManager.getAuthFeeCeiling(1)).toString(), newCeiling);
  });

  it("20. lowerAuthFeeCeiling below authFee reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerAuthFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below authFee"
    );
  });

  // ======================================================
  // lowerMintFeeCeiling
  // ======================================================

  it("21. lowerMintFeeCeiling succeeds and emits event", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setMintFee(1, toWei('0.01'), { from: owner });

    const newCeiling = toWei('0.05');
    const tx = await networkManager.lowerMintFeeCeiling(1, newCeiling, { from: owner });

    truffleAssert.eventEmitted(tx, 'MintFeeCeilingLowered', (ev) => {
      return ev.networkId.toNumber() === 1 &&
             ev.oldCeiling.toString() === ceiling &&
             ev.newCeiling.toString() === newCeiling;
    });

    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), newCeiling);
  });

  it("22. lowerMintFeeCeiling below mintFee reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerMintFeeCeiling(1, toWei('0.04'), { from: owner }),
      "below mintFee"
    );
  });

  // ======================================================
  // Access control
  // ======================================================

  it("23. lowerWithdrawFeeCeiling called by non-owner reverts", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setWithdrawFee(1, 0, { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerWithdrawFeeCeiling(1, toWei('0.05'), { from: nonOwner }),
      "Not the owner"
    );
  });

  it("24. lowerMintFeeCeiling reverts after fees are locked", async () => {
    const ceiling = toWei('0.10');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.lockNetworkFees(1, { from: owner });
    await truffleAssert.reverts(
      networkManager.lowerMintFeeCeiling(1, toWei('0.05'), { from: owner }),
      "Fees locked"
    );
  });

  // ======================================================
  // Getter reads
  // ======================================================

  it("25a. getWithdrawFeeCeiling returns the ceiling set at creation", async () => {
    const ceiling = toWei('0.42');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, 0, 0, 0, "500000000000", { from: owner });
    assert.equal((await networkManager.getWithdrawFeeCeiling(1)).toString(), ceiling);
  });

  it("25b. getDepositFeeCeiling reflects updated value after lowerDepositFeeCeiling", async () => {
    const ceiling    = toWei('0.10');
    const newCeiling = toWei('0.03');
    await networkManager.createNetwork("Net", owner, l2Eid, ceiling, ceiling, ceiling, ceiling, "500000000000", { from: owner });
    await networkManager.setDepositFee(1, toWei('0.01'), { from: owner });
    await networkManager.lowerDepositFeeCeiling(1, newCeiling, { from: owner });
    assert.equal((await networkManager.getDepositFeeCeiling(1)).toString(), newCeiling);
  });

  it("25c. getMintFeeCeiling returns 0 for a permanently-free mint network", async () => {
    await networkManager.createNetwork("Net", owner, l2Eid, toWei('0.01'), toWei('0.01'), toWei('0.01'), 0, "500000000000", { from: owner });
    assert.equal((await networkManager.getMintFeeCeiling(1)).toString(), '0');
  });
});
