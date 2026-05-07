// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../CawActions.sol";

/// @notice Test-only helper. Exposes CawActions._computeStructHash and the
///         per-action keccak slice + EIP-712 digest pipeline through public
///         entry points so tests (and the Rust circuit equivalence harness)
///         can call them with arbitrary ActionData inputs and compare.
///
/// @dev    NOT deployed in production. Lives under test-helpers/ so the
///         compiler only pulls it into truffle/hardhat builds. The exposed
///         functions just forward to the parent's internal logic — no new
///         state, no new code paths.
contract CawActionsDigestExposer is CawActions {
    constructor(address _cawProfileL2) CawActions(_cawProfileL2) {}

    /// @notice Public access to `_computeStructHash` for digest equivalence
    ///         testing against the Rust circuit.
    function exposeComputeStructHash(ActionData memory data) external pure returns (bytes32) {
        return _computeStructHash(data);
    }

    /// @notice Full EIP-712 digest = keccak256("\x19\x01" || domain || structHash).
    ///         Useful when the test wants to compare end-to-end digests, not
    ///         just the inner struct hash.
    function exposeEip712Digest(ActionData memory data) external view returns (bytes32) {
        bytes32 structHash = _computeStructHash(data);
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), eip712DomainHash, structHash));
    }
}
