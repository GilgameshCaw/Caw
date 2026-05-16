const CawNetworkManager = artifacts.require("CawNetworkManager");
const truffleAssert = require('truffle-assertions');

contract("CawNetworkManager - Instance Registry", (accounts) => {
  let networkManager;
  const owner = accounts[0];
  const instanceOperator = accounts[1];
  const otherUser = accounts[2];
  const buyAndBurn = accounts[9];

  const l2Eid = 40245; // Base Sepolia

  before(async () => {
    networkManager = await CawNetworkManager.new(buyAndBurn, { from: owner });
    // Create a network so we can register instances against it
    await networkManager.createNetwork("Test Network", owner, l2Eid, 1, 1, 1, 1, web3.utils.toWei('100000'), { from: owner });
  });

  describe("registerInstance", () => {
    it("should register an instance for an existing network", async () => {
      const tx = await networkManager.registerInstance(
        1,
        "https://api.testcaw.xyz",
        instanceOperator,
        { from: instanceOperator }
      );

      truffleAssert.eventEmitted(tx, 'InstanceRegistered', (ev) => {
        return ev.instanceId.toNumber() === 1 &&
               ev.networkId.toNumber() === 1 &&
               ev.owner === instanceOperator &&
               ev.apiUrl === "https://api.testcaw.xyz" &&
               ev.validatorAddress === instanceOperator;
      });

      assert.equal(await networkManager.instanceOwner(1), instanceOperator);
      assert.equal(await networkManager.instanceActive(1), true);
    });

    it("should allow anyone to register for any network (permissionless)", async () => {
      const tx = await networkManager.registerInstance(
        1,
        "https://api2.testcaw.xyz",
        otherUser,
        { from: otherUser }
      );

      truffleAssert.eventEmitted(tx, 'InstanceRegistered', (ev) => {
        return ev.instanceId.toNumber() === 2 &&
               ev.networkId.toNumber() === 1 &&
               ev.owner === otherUser;
      });
    });

    it("should auto-increment instance IDs", async () => {
      assert.equal((await networkManager.nextInstanceId()).toNumber(), 3);
    });

    it("should reject registration for non-existent network", async () => {
      await truffleAssert.reverts(
        networkManager.registerInstance(999, "https://api.test.xyz", instanceOperator, { from: instanceOperator }),
        "Network does not exist"
      );
    });

    it("should reject registration with empty API URL", async () => {
      await truffleAssert.reverts(
        networkManager.registerInstance(1, "", instanceOperator, { from: instanceOperator }),
        "API URL required"
      );
    });

    it("should reject registration with zero validator address", async () => {
      await truffleAssert.reverts(
        networkManager.registerInstance(1, "https://api.test.xyz", "0x0000000000000000000000000000000000000000", { from: instanceOperator }),
        "Validator address required"
      );
    });
  });

  describe("updateInstance", () => {
    it("should allow instance owner to update", async () => {
      const tx = await networkManager.updateInstance(
        1,
        "https://api-v2.testcaw.xyz",
        instanceOperator,
        { from: instanceOperator }
      );

      truffleAssert.eventEmitted(tx, 'InstanceUpdated', (ev) => {
        return ev.instanceId.toNumber() === 1 &&
               ev.apiUrl === "https://api-v2.testcaw.xyz" &&
               ev.validatorAddress === instanceOperator;
      });
    });

    it("should reject update from non-owner", async () => {
      await truffleAssert.reverts(
        networkManager.updateInstance(1, "https://evil.xyz", otherUser, { from: otherUser }),
        "Not instance owner"
      );
    });
  });

  describe("deactivateInstance / activateInstance", () => {
    it("should allow owner to deactivate", async () => {
      const tx = await networkManager.deactivateInstance(1, { from: instanceOperator });

      truffleAssert.eventEmitted(tx, 'InstanceDeactivated', (ev) => {
        return ev.instanceId.toNumber() === 1;
      });

      assert.equal(await networkManager.instanceActive(1), false);
    });

    it("should reject deactivation from non-owner", async () => {
      await truffleAssert.reverts(
        networkManager.deactivateInstance(2, { from: instanceOperator }),
        "Not instance owner"
      );
    });

    it("should allow owner to reactivate", async () => {
      const tx = await networkManager.activateInstance(1, { from: instanceOperator });

      truffleAssert.eventEmitted(tx, 'InstanceActivated', (ev) => {
        return ev.instanceId.toNumber() === 1;
      });

      assert.equal(await networkManager.instanceActive(1), true);
    });

    it("should reject activation from non-owner", async () => {
      await truffleAssert.reverts(
        networkManager.activateInstance(1, { from: otherUser }),
        "Not instance owner"
      );
    });
  });
});
