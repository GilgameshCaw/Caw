// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface to the OApp surface we need.
interface IOAppOwner {
  function owner() external view returns (address);
  function transferOwnership(address newOwner) external;
  function renounceOwnership() external;
  function peers(uint32 eid) external view returns (bytes32);
  function setPeer(uint32 eid, bytes32 peer) external;
}

/// @title PathwayExpander
/// @notice Becomes the owner of every CAW OApp (CawProfile, CawProfileL2,
///         CawActionsArchive, CawChallengeRelay) so that the deployer EOA
///         can renounce its direct authority over them while still leaving
///         the door open for ONE specific operation: adding peers for new
///         eids.
///
///         The original CAW OApps already gate setPeer per-eid via
///         OnlyOnce, so existing peers can never be reconfigured. This
///         contract reinforces that with its own check (peers[eid] == 0
///         required) — defense in depth — and adds nothing else. There
///         is no path to:
///           - reconfigure existing peers,
///           - rotate the LZ delegate,
///           - call any other OnlyOwner function on the underlying OApp,
///           - transfer the OApp's ownership to anything else.
///         If a future protocol wants any of those, it has to deploy a
///         new PathwayExpander variant and migrate ownership *before*
///         this one is renounced.
///
/// @dev Trust profile: this contract has its own owner (the deployer or
///      whatever address it's transferred to). The owner can call
///      addPeer to bring up new pathways. The owner CANNOT pull
///      ownership of the underlying OApps back out — there is no
///      "transferOApp" function. This is intentional: the upstream
///      OApps' OnlyOnce per-eid guards are what make existing pathways
///      immutable, and this contract preserves that property.
///
///      The owner CAN renounceOwnership() on this contract, which
///      neutralizes the additions-only path entirely (no new chains
///      ever again, but all existing pathways keep working).
contract PathwayExpander is Ownable {
  event PeerAdded(address indexed oapp, uint32 indexed eid, bytes32 peer);

  constructor(address _owner) {
    require(_owner != address(0), "PathwayExpander: zero address");
    _transferOwnership(_owner);
  }

  /// @notice Add a peer for a new eid on an OApp this contract owns.
  /// @dev    Reverts if the eid already has a peer set on the OApp,
  ///         which means existing pathways are unmovable. Also reverts
  ///         if this contract isn't the OApp's owner — early failure
  ///         is friendlier than letting the call dispatch into the
  ///         OApp and revert there with onlyOwner.
  /// @param  oapp The OApp contract whose peer table we're extending.
  /// @param  eid  The new LayerZero eid to register.
  /// @param  peer The peer address (bytes32-encoded for non-EVM compat).
  function addPeer(address oapp, uint32 eid, bytes32 peer) external onlyOwner {
    _addPeer(oapp, eid, peer);
  }

  /// @notice Convenience batch wrapper. Same per-call semantics as addPeer.
  function addPeers(
    address[] calldata oapps,
    uint32[] calldata eids,
    bytes32[] calldata peers
  ) external onlyOwner {
    uint256 n = oapps.length;
    require(n == eids.length && n == peers.length, "PathwayExpander: length mismatch");
    for (uint256 i; i < n; ++i) {
      _addPeer(oapps[i], eids[i], peers[i]);
    }
  }

  function _addPeer(address oapp, uint32 eid, bytes32 peer) internal {
    require(oapp != address(0), "PathwayExpander: zero address");
    require(peer != bytes32(0), "PathwayExpander: zero peer");

    IOAppOwner o = IOAppOwner(oapp);
    require(o.owner() == address(this), "PathwayExpander: not OApp owner");

    require(o.peers(eid) == bytes32(0), "PathwayExpander: peer already set");

    o.setPeer(eid, peer);
    emit PeerAdded(oapp, eid, peer);
  }
}
