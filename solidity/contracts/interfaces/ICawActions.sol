// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICawActions {
  function nextCawonce(uint32 senderId) external view returns (uint256);

  // ── ERC-1271 sibling callbacks ────────────────────────────────────────────
  // Called by CawActionsERC1271 only.

  function eip712DomainHash() external view returns (bytes32);
  function cawProfile() external view returns (address);

  /// @notice Apply one group with a pre-verified ERC-1271 signer (sibling-only
  ///         when preVerifiedSigner != address(0)). The `r` arg is the hash-chain
  ///         anchor (= keccak256(sigBlob)); `v` and `s` are ignored in sibling mode.
  function processGroupSingle(
    uint32 validatorId,
    bytes calldata groupBytes,
    uint8 v, bytes32 r, bytes32 s,
    uint16 groupSize,
    address preVerifiedSigner
  ) external;
}
