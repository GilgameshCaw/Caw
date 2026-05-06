// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal stand-in for the OApp surface PathwayExpander touches.
///         Exposes ownership + a peer table that only the owner can write.
///         Used exclusively in tests.
contract MockOAppOwnable is Ownable {
  mapping(uint32 => bytes32) public peers;
  event PeerSet(uint32 indexed eid, bytes32 peer);

  function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
    peers[eid] = peer;
    emit PeerSet(eid, peer);
  }
}
