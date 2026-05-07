// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ISP1Verifier } from "../IZKActionsVerifier.sol";

/// @notice Test-only mock of Succinct's SP1Verifier. Lets us exercise the
///         state-application path of `processActionsWithZkSigs` without
///         spending 10+ minutes generating a real Groth16 proof per test.
///
///         The cryptographic guarantee is covered separately:
///           - sig-recovery-program (the circuit) is the only place the
///             actual ECDSA recovery happens. The digest equivalence test
///             (zk-digest-equivalence-test.js) proves the circuit's digest
///             math matches Solidity byte-for-byte.
///           - The end-to-end test on Base Sepolia (#18) submits a real
///             proof against the canonical SP1Verifier and confirms the
///             whole pipeline.
///
///         This mock just toggles between accept/reject so unit tests can
///         drive the on-chain state transitions cleanly.
contract MockSP1Verifier is ISP1Verifier {
    bool public shouldAccept = true;

    /// @notice Set the next verify call's outcome. Default is accept.
    function setShouldAccept(bool ok) external {
        shouldAccept = ok;
    }

    /// @inheritdoc ISP1Verifier
    function verifyProof(
        bytes32, /* programVKey */
        bytes calldata, /* publicValues */
        bytes calldata /* proofBytes */
    ) external view {
        require(shouldAccept, "Mock verifier: rejected");
    }
}
