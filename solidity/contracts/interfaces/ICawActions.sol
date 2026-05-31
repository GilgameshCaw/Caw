// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICawActions {
  function nextCawonce(uint32 senderId) external view returns (uint256);

  // ── Cap oracle push interface ─────────────────────────────────────────────
  // Called by CawCapOracle to push the current TWAP ratio into storage so
  // CawActions can read it per-batch (zero external calls per action).

  /// @notice Returns the currently stored cap ratio (UQ112.112 WETH-per-CAW).
  ///         Zero means the cap is dormant and baseline action costs apply.
  function capStateRatio() external view returns (uint192);

  /// @notice Called by CawCapOracle to push a new TWAP ratio.
  ///         Caller must be the immutable capOracle address or the call reverts.
  function setCapRatio(uint192 newRatio) external;

  /// @notice Returns the currently stored tip state (lastUpdatedAt, ratio).
  ///         ratio == 0 means the tip oracle is dormant.
  function tipState() external view returns (uint64 lastUpdatedAt, uint192 ratio);

  /// @notice Called by CawCapOracle to push a new tip TWAP ratio.
  ///         Caller must be the immutable capOracle address or the call reverts.
  function setTipRatio(uint192 newRatio) external;

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
