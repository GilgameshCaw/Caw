// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title OnlyOnce
/// @notice Modifier that permits a given call site to run at most once per contract instance.
/// @dev Inherit this and tag post-deploy address setters with `onlyOnce(bytes32(keccak256("setFoo")))`.
abstract contract OnlyOnce {
  mapping(bytes32 => bool) private _used;

  modifier onlyOnce(bytes32 key) {
    require(!_used[key], "OnlyOnce: already called");
    _used[key] = true;
    _;
  }
}
