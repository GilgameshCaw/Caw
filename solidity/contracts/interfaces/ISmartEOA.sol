// contracts/interfaces/ISmartEOA.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal interface for sponsor entry-point nonce management.
///         Implemented by SmartEOA.sol (and any Population C wallet that
///         exposes the same monotonic per-(verifyingContract, actionType) nonce).
interface ISmartEOA {
    /// @notice Read the current nonce for a (verifyingContract, actionType) pair.
    ///         Called by CawProfileMinter when assembling the EIP-712 permit digest
    ///         and again to verify the caller-supplied permitNonce before consuming it.
    function nonceOf(address verifyingContract, uint8 actionType)
        external
        view
        returns (uint256);

    /// @notice Consume (increment) the nonce for a (verifyingContract, actionType) pair.
    ///         Gated to msg.sender == verifyingContract — only the Minter can advance
    ///         its own nonce sequence.  See SmartEOA.consumeNonce natspec for the
    ///         TOCTOU rationale.
    function consumeNonce(address verifyingContract, uint8 actionType) external;
}
