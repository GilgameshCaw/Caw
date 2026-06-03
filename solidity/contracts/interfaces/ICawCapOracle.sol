// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICawCapOracle
/// @notice Minimal interface for the L2 cap oracle. The full CawCapOracle ABI
///         lives in CawCapOracle.sol. This interface covers only the methods
///         called from CawActions and CawProfileLedger.
interface ICawCapOracle {
  /// @notice Returns the per-action CAW cap given the manifesto baseline and
  ///         the ETH-denominated ceiling. Retained for off-chain tooling and
  ///         view consumers; CawActions no longer calls this per-action.
  /// @param  baseline   Whole CAW tokens (manifesto amount for the action).
  /// @param  ethCap     ETH ceiling for the action (wei).
  /// @return capped     Effective CAW cost after applying the cap.
  function capForAction(uint256 baseline, uint256 ethCap) external view returns (uint256 capped);

  /// @notice Record a price sample. Called by the authorised L2 writer
  ///         (CawProfileLedger) for each L1->L2 message.
  function recordSample(uint256 cumulative, uint32 timestamp) external;
}
