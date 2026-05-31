// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal mock that satisfies the ICawActions interface used by CawCapOracle.
///      Used only in truffle/hardhat tests — never deployed in production.
contract MockCawActionsCapTarget {
  uint192 private _capRatio;
  uint192 public lastSetRatio;
  uint256 public setRatioCallCount;

  uint192 private _tipRatio;
  uint192 public lastSetTipRatio;
  uint256 public setTipRatioCallCount;

  function capStateRatio() external view returns (uint192) {
    return _capRatio;
  }

  function setCapRatio(uint192 newRatio) external {
    _capRatio = newRatio;
    lastSetRatio = newRatio;
    setRatioCallCount++;
  }

  function tipState() external view returns (uint64 lastUpdatedAt, uint192 ratio) {
    return (0, _tipRatio);
  }

  function setTipRatio(uint192 newRatio) external {
    _tipRatio = newRatio;
    lastSetTipRatio = newRatio;
    setTipRatioCallCount++;
  }
}
