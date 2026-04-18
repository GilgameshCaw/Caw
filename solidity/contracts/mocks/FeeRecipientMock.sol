// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Test helper: a minimal contract that can receive ETH via call.
///         Used to verify that CawProfile.withdrawFees() works for contract recipients
///         (which would have failed with the old `.transfer()` 2300-gas stipend).
contract FeeRecipientMock {
  uint256 public received;

  receive() external payable {
    // Do something that would exceed the 2300 gas stipend of .transfer()
    received += msg.value;
  }
}
