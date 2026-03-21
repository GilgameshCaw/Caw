const CawClientManager = artifacts.require("CawClientManager");
const truffleAssert = require('truffle-assertions');

contract("CawClientManager - Instance Registry", (accounts) => {
  let clientManager;
  const owner = accounts[0];
  const instanceOperator = accounts[1];
  const otherUser = accounts[2];
  const buyAndBurn = accounts[9];

  const l2Eid = 40245; // Base Sepolia

  before(async () => {
    clientManager = await CawClientManager.new(buyAndBurn, { from: owner });
    // Create a client so we can register instances against it
    await clientManager.createClient("Test Client", owner, l2Eid, 1, 1, 1, 1, { from: owner });
  });

  describe("registerInstance", () => {
    it("should register an instance for an existing client", async () => {
      const tx = await clientManager.registerInstance(
        1,
        "https://api.testcaw.xyz",
        instanceOperator,
        { from: instanceOperator }
      );

      truffleAssert.eventEmitted(tx, 'InstanceRegistered', (ev) => {
        return ev.instanceId.toNumber() === 1 &&
               ev.clientId.toNumber() === 1 &&
               ev.owner === instanceOperator &&
               ev.apiUrl === "https://api.testcaw.xyz" &&
               ev.validatorAddress === instanceOperator;
      });

      assert.equal(await clientManager.instanceOwner(1), instanceOperator);
      assert.equal(await clientManager.instanceActive(1), true);
    });

    it("should allow anyone to register for any client (permissionless)", async () => {
      const tx = await clientManager.registerInstance(
        1,
        "https://api2.testcaw.xyz",
        otherUser,
        { from: otherUser }
      );

      truffleAssert.eventEmitted(tx, 'InstanceRegistered', (ev) => {
        return ev.instanceId.toNumber() === 2 &&
               ev.clientId.toNumber() === 1 &&
               ev.owner === otherUser;
      });
    });

    it("should auto-increment instance IDs", async () => {
      assert.equal((await clientManager.nextInstanceId()).toNumber(), 3);
    });

    it("should reject registration for non-existent client", async () => {
      await truffleAssert.reverts(
        clientManager.registerInstance(999, "https://api.test.xyz", instanceOperator, { from: instanceOperator }),
        "Client does not exist"
      );
    });

    it("should reject registration with empty API URL", async () => {
      await truffleAssert.reverts(
        clientManager.registerInstance(1, "", instanceOperator, { from: instanceOperator }),
        "API URL required"
      );
    });

    it("should reject registration with zero validator address", async () => {
      await truffleAssert.reverts(
        clientManager.registerInstance(1, "https://api.test.xyz", "0x0000000000000000000000000000000000000000", { from: instanceOperator }),
        "Validator address required"
      );
    });
  });

  describe("updateInstance", () => {
    it("should allow instance owner to update", async () => {
      const tx = await clientManager.updateInstance(
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
        clientManager.updateInstance(1, "https://evil.xyz", otherUser, { from: otherUser }),
        "Not instance owner"
      );
    });
  });

  describe("deactivateInstance / activateInstance", () => {
    it("should allow owner to deactivate", async () => {
      const tx = await clientManager.deactivateInstance(1, { from: instanceOperator });

      truffleAssert.eventEmitted(tx, 'InstanceDeactivated', (ev) => {
        return ev.instanceId.toNumber() === 1;
      });

      assert.equal(await clientManager.instanceActive(1), false);
    });

    it("should reject deactivation from non-owner", async () => {
      await truffleAssert.reverts(
        clientManager.deactivateInstance(2, { from: instanceOperator }),
        "Not instance owner"
      );
    });

    it("should allow owner to reactivate", async () => {
      const tx = await clientManager.activateInstance(1, { from: instanceOperator });

      truffleAssert.eventEmitted(tx, 'InstanceActivated', (ev) => {
        return ev.instanceId.toNumber() === 1;
      });

      assert.equal(await clientManager.instanceActive(1), true);
    });

    it("should reject activation from non-owner", async () => {
      await truffleAssert.reverts(
        clientManager.activateInstance(1, { from: otherUser }),
        "Not instance owner"
      );
    });
  });
});
