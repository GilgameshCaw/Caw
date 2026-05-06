const PathwayExpander = artifacts.require("PathwayExpander");
const MockOAppOwnable = artifacts.require("MockOAppOwnable");
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
});
