// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title GasMeter
/// @notice Test-only harness for measuring the execution cost of a single call in isolation.
///         Used by scripts/measure-gas.js to benchmark LayerZero lzReceive handlers without
///         paying for intrinsic tx gas or calldata gas. Not deployed in production.
contract GasMeter {
  event Measured(uint256 gasUsed, bool success, bytes returnData);

  /// @notice Call `target` with `data`, record the exact execution gas used.
  /// @dev `gasleft()` is cheap and deterministic; the delta is purely the execution cost
  ///      of the sub-call, excluding the outer tx's intrinsic 21k + calldata gas.
  function measure(address target, bytes calldata data) external returns (uint256 gasUsed, bool success, bytes memory returnData) {
    uint256 gasBefore = gasleft();
    (success, returnData) = target.call(data);
    uint256 gasAfter = gasleft();
    gasUsed = gasBefore - gasAfter;
    emit Measured(gasUsed, success, returnData);
  }

  /// @notice Same as measure(), but forwards the given msg.sender by calling from `impersonator`.
  ///         Not actually used from the script — kept as a reference for future harness variants.
  function measureFrom(address target, bytes calldata data) external returns (uint256 gasUsed) {
    uint256 gasBefore = gasleft();
    (bool success, ) = target.call(data);
    require(success, "sub-call reverted");
    gasUsed = gasBefore - gasleft();
  }
}
