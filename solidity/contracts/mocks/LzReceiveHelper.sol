// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test helper that calls lzReceive on a target OApp contract.
///      Deploy this and pass its address as the endpoint when constructing
///      the OApp under test. Then call deliver() to simulate LZ message delivery.
contract LzReceiveHelper {
  struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
  }

  function deliver(
    address target,
    uint32 srcEid,
    bytes32 sender,
    uint64 nonce,
    bytes32 guid,
    bytes calldata message
  ) external {
    // Call the OApp's lzReceive. The OApp checks msg.sender == endpoint,
    // and since THIS contract is the endpoint, the check passes.
    (bool ok, bytes memory ret) = target.call(
      abi.encodeWithSignature(
        "lzReceive((uint32,bytes32,uint64),bytes32,bytes,address,bytes)",
        Origin(srcEid, sender, nonce),
        guid,
        message,
        msg.sender, // executor
        "" // extra data
      )
    );
    if (!ok) {
      assembly { revert(add(ret, 32), mload(ret)) }
    }
  }

  // Stubs required by OApp's endpoint interface checks
  function setDelegate(address) external {}
}
