// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal mock that satisfies the ICawActions interface used by CawCapOracle.
///      Used only in truffle/hardhat tests — never deployed in production.
contract MockCawActionsCapTarget {
  uint192 private _ratio;
  uint192 public lastSetRatio;
  uint256 public setRatioCallCount;

  function capStateRatio() external view returns (uint192) {
    return _ratio;
  }

  function setCapRatio(uint192 newRatio) external {
    _ratio = newRatio;
    lastSetRatio = newRatio;
    setRatioCallCount++;
  }
}
