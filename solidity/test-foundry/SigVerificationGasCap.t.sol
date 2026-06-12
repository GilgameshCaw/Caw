// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import { SigVerification } from "../contracts/SigVerification.sol";

// Regression test for the ERC1271_GAS_LIMIT bump 50k -> 150k.
//
// WebAuthn/P-256 verification inside SmartEOA.isValidSignature costs ~55-68k
// (EIP-7951 precompile + clientDataJSON parse). The old 50k cap silently
// rejected passkey-signed registerSession/registerSessionPersonal as BadSig.
// These tests prove a verifier that consumes ~60k now PASSES (it would have
// failed at 50k), while the cap still bounds a runaway/malicious verifier so
// it can't grief the relaying caller.
//
// SigVerification is an `internal` library — it inlines, so we exercise it via
// a thin wrapper contract.

bytes4 constant ERC1271_MAGIC = 0x1626ba7e;

/// @dev Wrapper exposing the internal library fn so the test can call it
///      across a contract boundary (real gas accounting, no inlining into the
///      test harness).
contract SigVerificationWrapper {
    function validate(address signer, bytes32 digest, bytes calldata sig)
        external
        view
        returns (bool)
    {
        return SigVerification.recoverOrValidate(signer, digest, sig);
    }
}

/// @dev ERC-1271 verifier that burns a configurable amount of gas before
///      returning the magic value — models the cost of WebAuthn verification.
contract GasBurningVerifier {
    uint256 public immutable burnGas;
    constructor(uint256 _burnGas) { burnGas = _burnGas; }

    function isValidSignature(bytes32 /*hash*/, bytes calldata sig)
        external
        view
        returns (bytes4)
    {
        if (sig.length == 0) return bytes4(0xffffffff);
        // Spin until we've consumed ~burnGas. The loop reads gasleft() each
        // iteration; the staticcall from SigVerification caps total forwarded
        // gas, so if burnGas exceeds the cap this OOGs inside the staticcall
        // and surfaces as `false` (identical to a 1271 reject).
        uint256 start = gasleft();
        uint256 acc;
        while (start - gasleft() < burnGas) {
            acc = uint256(keccak256(abi.encode(acc)));
        }
        // Touch acc so the optimizer can't elide the loop.
        if (acc == type(uint256).max) return bytes4(0xffffffff);
        return ERC1271_MAGIC;
    }
}

contract SigVerificationGasCapTest is Test {
    SigVerificationWrapper internal wrapper;

    function setUp() public {
        wrapper = new SigVerificationWrapper();
    }

    /// A verifier costing ~60k gas (between the old 50k cap and the new 150k)
    /// must now be ACCEPTED. This is the WebAuthn case that was broken at 50k.
    function test_webauthnClassVerifier_passesAt150k() public {
        GasBurningVerifier v = new GasBurningVerifier(60_000);
        bool ok = wrapper.validate(address(v), keccak256("digest"), hex"01");
        assertTrue(ok, "verifier burning ~60k gas should validate under the 150k cap");
    }

    /// Just under the new cap should still pass (headroom check).
    function test_verifierJustUnderCap_passes() public {
        GasBurningVerifier v = new GasBurningVerifier(120_000);
        bool ok = wrapper.validate(address(v), keccak256("digest"), hex"02");
        assertTrue(ok, "verifier burning ~120k gas should validate under the 150k cap");
    }

    /// A runaway/malicious verifier that tries to consume far more than the cap
    /// must still be REJECTED (OOG inside the staticcall -> false), so it can't
    /// grief the relayer. Confirms the cap is still bounding griefing.
    function test_runawayVerifier_stillRejected() public {
        GasBurningVerifier v = new GasBurningVerifier(2_000_000);
        bool ok = wrapper.validate(address(v), keccak256("digest"), hex"03");
        assertFalse(ok, "verifier burning 2M gas must be rejected by the gas cap");
    }

    /// Empty signature is always rejected regardless of cap.
    function test_emptySig_rejected() public {
        GasBurningVerifier v = new GasBurningVerifier(10_000);
        bool ok = wrapper.validate(address(v), keccak256("digest"), hex"");
        assertFalse(ok, "empty signature must be rejected");
    }
}
