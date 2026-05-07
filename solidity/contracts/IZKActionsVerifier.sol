// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface to Succinct's SP1Verifier (the canonical
///         on-chain verifier for SP1-generated Groth16 proofs).
///
///         CawActions calls this from the immutable address pinned at
///         deploy. Reverts on any verification failure (invalid proof,
///         wrong vkey, malformed public values).
interface ISP1Verifier {
    function verifyProof(
        bytes32 programVKey,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external view;
}
