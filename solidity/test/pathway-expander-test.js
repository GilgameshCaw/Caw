const PathwayExpander = artifacts.require("PathwayExpander");
const MockOAppOwnable = artifacts.require("MockOAppOwnable");
const MockLzEndpointSimple = artifacts.require("MockLzEndpointSimple");
const truffleAssert = require('truffle-assertions');

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// Helper: address → left-padded bytes32 (LZ peer encoding for EVM peers).
function addrToBytes32(addr) {
  return '0x' + '00'.repeat(12) + addr.slice(2).toLowerCase();
}

contract("PathwayExpander", (accounts) => {
  const deployer = accounts[0];   // initial owner of the OApps & expander
  const expanderOwner = accounts[1]; // who controls the expander after handoff
  const stranger = accounts[2];
  const peerA = accounts[5];
  const peerB = accounts[6];
  const peerC = accounts[7];

  const EID_BASE = 40245;
  const EID_ARB  = 40231;
  const EID_OP   = 40232; // a hypothetical new chain we'd expand to

  let expander;
  let oapp1, oapp2;

  beforeEach(async () => {
    expander = await PathwayExpander.new(expanderOwner, { from: deployer });
    oapp1 = await MockOAppOwnable.new({ from: deployer });
    oapp2 = await MockOAppOwnable.new({ from: deployer });
  });

  describe("constructor", () => {
    it("rejects zero owner", async () => {
      await truffleAssert.reverts(
        PathwayExpander.new(ZERO_ADDR, { from: deployer }),
        "PathwayExpander: zero address"
      );
    });

    it("sets owner to the supplied address (not msg.sender)", async () => {
      assert.equal(await expander.owner(), expanderOwner);
    });
  });

  describe("addPeer — owned-by-expander OApp", () => {
    beforeEach(async () => {
      // Hand the OApp's ownership to the expander, mirroring the real
      // renounce flow: deployer → expander → (eventually renounce).
      await oapp1.transferOwnership(expander.address, { from: deployer });
    });

    it("adds a fresh peer when slot is empty", async () => {
      const peer = addrToBytes32(peerA);
      const tx = await expander.addPeer(oapp1.address, EID_BASE, peer, { from: expanderOwner });

      truffleAssert.eventEmitted(tx, 'PeerAdded', (ev) =>
        ev.oapp === oapp1.address &&
        ev.eid.toString() === String(EID_BASE) &&
        ev.peer.toLowerCase() === peer
      );
      assert.equal((await oapp1.peers(EID_BASE)).toLowerCase(), peer);
    });

    it("rejects a duplicate eid (existing peer is immutable)", async () => {
      const peer = addrToBytes32(peerA);
      await expander.addPeer(oapp1.address, EID_BASE, peer, { from: expanderOwner });
      await truffleAssert.reverts(
        expander.addPeer(oapp1.address, EID_BASE, addrToBytes32(peerB), { from: expanderOwner }),
        "PathwayExpander: peer already set"
      );
    });

    it("allows different eids on the same OApp", async () => {
      await expander.addPeer(oapp1.address, EID_BASE, addrToBytes32(peerA), { from: expanderOwner });
      await expander.addPeer(oapp1.address, EID_ARB,  addrToBytes32(peerB), { from: expanderOwner });
      assert.equal((await oapp1.peers(EID_BASE)).toLowerCase(), addrToBytes32(peerA));
      assert.equal((await oapp1.peers(EID_ARB)).toLowerCase(),  addrToBytes32(peerB));
    });

    it("rejects calls from non-owner of the expander", async () => {
      await truffleAssert.reverts(
        expander.addPeer(oapp1.address, EID_BASE, addrToBytes32(peerA), { from: stranger }),
        "Ownable: caller is not the owner"
      );
    });

    it("rejects zero peer", async () => {
      await truffleAssert.reverts(
        expander.addPeer(oapp1.address, EID_BASE, ZERO_BYTES32, { from: expanderOwner }),
        "PathwayExpander: zero peer"
      );
    });

    it("rejects zero oapp address", async () => {
      await truffleAssert.reverts(
        expander.addPeer(ZERO_ADDR, EID_BASE, addrToBytes32(peerA), { from: expanderOwner }),
        "PathwayExpander: zero address"
      );
    });
  });

  describe("addPeer — when expander is NOT the OApp's owner", () => {
    it("reverts early before dispatching into the OApp", async () => {
      // oapp1 is still owned by deployer here, not the expander.
      await truffleAssert.reverts(
        expander.addPeer(oapp1.address, EID_BASE, addrToBytes32(peerA), { from: expanderOwner }),
        "PathwayExpander: not OApp owner"
      );
    });
  });

  describe("addPeers (batch)", () => {
    beforeEach(async () => {
      await oapp1.transferOwnership(expander.address, { from: deployer });
      await oapp2.transferOwnership(expander.address, { from: deployer });
    });

    it("adds multiple peers across multiple OApps in one tx", async () => {
      const tx = await expander.addPeers(
        [oapp1.address, oapp2.address, oapp1.address],
        [EID_BASE, EID_BASE, EID_ARB],
        [addrToBytes32(peerA), addrToBytes32(peerB), addrToBytes32(peerC)],
        { from: expanderOwner }
      );

      assert.equal((await oapp1.peers(EID_BASE)).toLowerCase(), addrToBytes32(peerA));
      assert.equal((await oapp2.peers(EID_BASE)).toLowerCase(), addrToBytes32(peerB));
      assert.equal((await oapp1.peers(EID_ARB)).toLowerCase(),  addrToBytes32(peerC));

      // 3 distinct PeerAdded events
      const events = tx.logs.filter(l => l.event === 'PeerAdded');
      assert.equal(events.length, 3);
    });

    it("reverts whole batch on a single duplicate (atomicity)", async () => {
      await expander.addPeer(oapp1.address, EID_BASE, addrToBytes32(peerA), { from: expanderOwner });

      await truffleAssert.reverts(
        expander.addPeers(
          [oapp2.address, oapp1.address],   // first call would succeed, second is dup
          [EID_BASE, EID_BASE],
          [addrToBytes32(peerB), addrToBytes32(peerC)],
          { from: expanderOwner }
        ),
        "PathwayExpander: peer already set"
      );
      // The first call's effect must have rolled back too.
      assert.equal(await oapp2.peers(EID_BASE), ZERO_BYTES32);
    });

    it("rejects length mismatches", async () => {
      await truffleAssert.reverts(
        expander.addPeers(
          [oapp1.address],
          [EID_BASE, EID_ARB],
          [addrToBytes32(peerA), addrToBytes32(peerB)],
          { from: expanderOwner }
        ),
        "PathwayExpander: length mismatch"
      );
    });

    it("rejects calls from non-owner of the expander", async () => {
      await truffleAssert.reverts(
        expander.addPeers(
          [oapp1.address],
          [EID_BASE],
          [addrToBytes32(peerA)],
          { from: stranger }
        ),
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("scope of authority — the things expander CANNOT do", () => {
    beforeEach(async () => {
      await oapp1.transferOwnership(expander.address, { from: deployer });
    });

    it("does not expose any way to transfer the OApp's ownership back out", async () => {
      const exposedFns = expander.abi
        .filter(e => e.type === 'function')
        .map(e => e.name);
      assert.notInclude(exposedFns, 'transferOAppOwnership');
      assert.notInclude(exposedFns, 'pullOwnership');
      assert.notInclude(exposedFns, 'migrate');
      // And the OApp's owner is and stays the expander.
      assert.equal(await oapp1.owner(), expander.address);
    });

    it("does not expose setDelegate / arbitrary call forwarding", async () => {
      // Truffle decorates contract instances with a generic `call`
      // helper; what matters is that the *contract's own* ABI doesn't
      // expose pass-through methods. abi only includes solidity-defined
      // functions, so we check there.
      const exposedFns = expander.abi
        .filter(e => e.type === 'function')
        .map(e => e.name);
      assert.notInclude(exposedFns, 'setDelegate');
      assert.notInclude(exposedFns, 'exec');
      assert.notInclude(exposedFns, 'execute');
      assert.notInclude(exposedFns, 'forward');
    });
  });

  describe("renouncing the expander itself", () => {
    beforeEach(async () => {
      await oapp1.transferOwnership(expander.address, { from: deployer });
    });

    it("after renounce, addPeer fails forever (chain-additions path is closed)", async () => {
      await expander.renounceOwnership({ from: expanderOwner });
      assert.equal(await expander.owner(), ZERO_ADDR);

      await truffleAssert.reverts(
        expander.addPeer(oapp1.address, EID_OP, addrToBytes32(peerA), { from: expanderOwner }),
        "Ownable: caller is not the owner"
      );
      // But existing peers still work — i.e. ownership of the OApp didn't move.
      assert.equal(await oapp1.owner(), expander.address);
    });
  });

  // ---------------------------------------------------------------------------
  // configureNewPathway tests (added for commit 5052e454 coverage)
  // ---------------------------------------------------------------------------

  describe("configureNewPathway", () => {
    // UlnConfig struct layout (mirrors PathwayExpander.sol):
    //   uint64    confirmations
    //   uint8     requiredDVNCount
    //   uint8     optionalDVNCount
    //   uint8     optionalDVNThreshold
    //   address[] requiredDVNs
    //   address[] optionalDVNs
    //
    // web3.eth.abi.encodeParameter with tuple type mirrors Solidity abi.encode(cfg).
    function makeUlnConfig(confirmations, requiredDVNs, optionalDVNs, threshold) {
      return web3.eth.abi.encodeParameter(
        {
          components: [
            { name: 'confirmations',        type: 'uint64'    },
            { name: 'requiredDVNCount',     type: 'uint8'     },
            { name: 'optionalDVNCount',     type: 'uint8'     },
            { name: 'optionalDVNThreshold', type: 'uint8'     },
            { name: 'requiredDVNs',         type: 'address[]' },
            { name: 'optionalDVNs',         type: 'address[]' },
          ],
          name: '',
          type: 'tuple',
        },
        {
          confirmations:        String(confirmations),
          requiredDVNCount:     requiredDVNs.length,
          optionalDVNCount:     optionalDVNs.length,
          optionalDVNThreshold: threshold,
          requiredDVNs:         requiredDVNs,
          optionalDVNs:         optionalDVNs,
        }
      );
    }

    const EID_NEW = 30101;

    let endpoint;
    let lib;
    let dvn1, dvn2, dvn3, dvn4;

    beforeEach(async () => {
      endpoint = await MockLzEndpointSimple.new({ from: deployer });
      // Use stable addresses from accounts to avoid any freshly-deployed-contract issues
      lib  = accounts[8];
      dvn1 = accounts[3];
      dvn2 = accounts[4];
      dvn3 = accounts[5];
      dvn4 = accounts[6];
    });

    // ------------------------------------------------------------------
    // 1. Happy path: emits event + writes state + calls endpoint once
    // ------------------------------------------------------------------
    it("happy path: isPathwayConfigured becomes true, PathwayConfigured event fires, endpoint called once", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);

      assert.equal(
        await expander.isPathwayConfigured(oapp1.address, lib, EID_NEW),
        false,
        "should be unconfigured before the call"
      );

      const tx = await expander.configureNewPathway(
        oapp1.address, endpoint.address, lib, EID_NEW, ulnConfig,
        { from: expanderOwner }
      );

      // State written
      assert.equal(
        await expander.isPathwayConfigured(oapp1.address, lib, EID_NEW),
        true,
        "isPathwayConfigured should be true after"
      );

      // Event emitted with correct args
      truffleAssert.eventEmitted(tx, 'PathwayConfigured', (ev) =>
        ev.oapp === oapp1.address &&
        ev.lib  === lib &&
        ev.eid.toString() === String(EID_NEW) &&
        ev.config === ulnConfig
      );

      // Endpoint received exactly one setConfig call with the right args
      assert.equal((await endpoint.callCount()).toString(), '1', "endpoint.callCount should be 1");
      assert.equal(await endpoint.lastOapp(), oapp1.address, "endpoint.lastOapp mismatch");
      assert.equal(await endpoint.lastLib(),  lib,           "endpoint.lastLib mismatch");
      assert.equal((await endpoint.lastEid()).toString(), String(EID_NEW), "endpoint.lastEid mismatch");
      assert.equal((await endpoint.lastConfigType()).toString(), '2', "configType should be CONFIG_TYPE_ULN=2");
      assert.equal(await endpoint.lastConfig(), ulnConfig, "endpoint.lastConfig mismatch");
    });

    // ------------------------------------------------------------------
    // 2. Zero-address / empty-config guard rails (4 sub-tests)
    // ------------------------------------------------------------------
    it("rejects zero oapp address", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      await truffleAssert.reverts(
        expander.configureNewPathway(
          ZERO_ADDR, endpoint.address, lib, EID_NEW, ulnConfig,
          { from: expanderOwner }
        ),
        "PathwayExpander: zero oapp"
      );
    });

    it("rejects zero endpoint address", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      await truffleAssert.reverts(
        expander.configureNewPathway(
          oapp1.address, ZERO_ADDR, lib, EID_NEW, ulnConfig,
          { from: expanderOwner }
        ),
        "PathwayExpander: zero endpoint"
      );
    });

    it("rejects zero lib address", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      await truffleAssert.reverts(
        expander.configureNewPathway(
          oapp1.address, endpoint.address, ZERO_ADDR, EID_NEW, ulnConfig,
          { from: expanderOwner }
        ),
        "PathwayExpander: zero lib"
      );
    });

    it("rejects empty ulnConfig bytes", async () => {
      await truffleAssert.reverts(
        expander.configureNewPathway(
          oapp1.address, endpoint.address, lib, EID_NEW, '0x',
          { from: expanderOwner }
        ),
        "PathwayExpander: empty config"
      );
    });

    // ------------------------------------------------------------------
    // 3. Double-configure reverts
    // ------------------------------------------------------------------
    it("double-configure same (oapp, lib, eid) reverts with 'pathway already configured'", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      await expander.configureNewPathway(
        oapp1.address, endpoint.address, lib, EID_NEW, ulnConfig,
        { from: expanderOwner }
      );
      await truffleAssert.reverts(
        expander.configureNewPathway(
          oapp1.address, endpoint.address, lib, EID_NEW, ulnConfig,
          { from: expanderOwner }
        ),
        "PathwayExpander: pathway already configured"
      );
      // Endpoint should still only have been called once (second call never reached it)
      assert.equal((await endpoint.callCount()).toString(), '1', "endpoint should only be called once");
    });

    // ------------------------------------------------------------------
    // 4. Per-(oapp, lib, eid) independence + addDvnToPathway state isolation
    // ------------------------------------------------------------------
    it("different oapps with same lib+eid are independent; addDvnToPathway on oappA leaves oappB unchanged", async () => {
      const ulnConfig  = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      const step1Config = makeUlnConfig(15, [], [dvn1, dvn2, dvn3, dvn4], 3);

      // Configure both oapps with the same (lib, eid) — both must succeed
      await expander.configureNewPathway(
        oapp1.address, endpoint.address, lib, EID_NEW, ulnConfig,
        { from: expanderOwner }
      );
      await expander.configureNewPathway(
        oapp2.address, endpoint.address, lib, EID_NEW, ulnConfig,
        { from: expanderOwner }
      );

      // Both are configured
      assert.equal(await expander.isPathwayConfigured(oapp1.address, lib, EID_NEW), true, "oapp1 should be configured");
      assert.equal(await expander.isPathwayConfigured(oapp2.address, lib, EID_NEW), true, "oapp2 should be configured");

      // Both start at step 0
      assert.equal(
        (await expander.dvnEscalationStep(oapp1.address, lib, EID_NEW)).toString(), '0',
        "oapp1 escalation step should be 0"
      );
      assert.equal(
        (await expander.dvnEscalationStep(oapp2.address, lib, EID_NEW)).toString(), '0',
        "oapp2 escalation step should be 0"
      );

      // Escalate only oapp1
      await expander.addDvnToPathway(
        oapp1.address, endpoint.address, lib, EID_NEW,
        ulnConfig, step1Config,
        { from: expanderOwner }
      );

      // oapp1 advanced to step 1; oapp2 must stay at step 0 (state isolation)
      assert.equal(
        (await expander.dvnEscalationStep(oapp1.address, lib, EID_NEW)).toString(), '1',
        "oapp1 escalation step should be 1 after addDvnToPathway"
      );
      assert.equal(
        (await expander.dvnEscalationStep(oapp2.address, lib, EID_NEW)).toString(), '0',
        "oapp2 escalation step must remain 0 (state isolation)"
      );
    });

    // ------------------------------------------------------------------
    // 5. Non-owner cannot call configureNewPathway
    // ------------------------------------------------------------------
    it("rejects calls from non-owner of the expander", async () => {
      const ulnConfig = makeUlnConfig(15, [], [dvn1, dvn2, dvn3], 2);
      await truffleAssert.reverts(
        expander.configureNewPathway(
          oapp1.address, endpoint.address, lib, EID_NEW, ulnConfig,
          { from: stranger }
        ),
        "Ownable: caller is not the owner"
      );
    });
  });
});
