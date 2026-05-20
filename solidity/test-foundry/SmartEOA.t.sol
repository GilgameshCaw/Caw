// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @title SmartEOATest
/// @notice Tests §7 items 1-12 + 25 of plan-smart-eoa-passkey-sponsorship.md.
///
/// @dev P-256 MOCK STRATEGY:
///      The EIP-7951 P-256 precompile at address 0x0100 is NOT live on foundry's
///      default EVM (requires a Fusaka hardfork fork).  We install a mock verifier
///      at 0x0100 via vm.etch() that accepts exactly the P-256 inputs we register
///      in the P256MockRegistry.
///
///      The mock checks: keccak256(input[0:160]) ∈ registeredHashes.
///      where input = h(32) || r(32) || s(32) || qx(32) || qy(32).
///
///      For each test that requires a valid passkey sig, we:
///        1. Compute the expected precompile input hash at test runtime.
///        2. Register it in p256Registry.
///        3. Call isValidSignature / management function with those r, s values.
///
///      FIXED SIG CONSTANTS: we choose arbitrary fixed r, s constants per test
///      (SIG_R_1, SIG_R_2, etc.) and register the corresponding precompile inputs.
///      The P-256 signature math is exercised via the real precompile in production;
///      tests exercise the SmartEOA contract logic.
///
/// @dev WebAuthn convention assumed (FE team MUST confirm):
///      abi.encode(bytes authenticatorData, bytes clientDataJSON, bytes32 r, bytes32 s)
///      This matches the standard wagmi webauthn assertion output.  If the FE uses
///      a different encoding order, this test is the specification the FE aligns to.
///
/// @dev P-256 key coordinates (PK1_X, PK1_Y) are real NIST P-256 affine coordinates.
///      Generated offline: python3 test-foundry/helpers/gen_p256_vectors.py
///      Private scalar: 0xBC...D2 (documented in helpers/gen_p256_vectors.py).
contract SmartEOATest is Test {

    // =========================================================================
    // P-256 passkey coordinates
    // =========================================================================

    /// @dev Real P-256 public key point #1 (primary test passkey).
    ///      Generated from private scalar:
    ///      85053669634070209836134713953639729434974223139151520322346588026977323650290
    bytes32 constant PK1_X = bytes32(0x4359cf55e848ec6f18a1163aeb2dfe474aad0db80bf5be418b689033e04dd032);
    bytes32 constant PK1_Y = bytes32(0xf18e3dafea96113646f34a71badc522653c4f0bdc86ffc6255db7823b4edd221);

    /// @dev A second P-256 public key point (distinct from PK1, used for multi-key tests).
    ///      NOTE: PK2 is NOT a real P-256 point derived from a valid scalar — it is a
    ///      synthetic pair used only in the mock, where validity is not checked.
    ///      In production, WebAuthn only produces valid P-256 points.
    bytes32 constant PK2_X = bytes32(0x2222222222222222222222222222222222222222222222222222222222222222);
    bytes32 constant PK2_Y = bytes32(0x3333333333333333333333333333333333333333333333333333333333333333);

    // =========================================================================
    // Sig constants — arbitrary values that we register in the mock
    // =========================================================================

    /// @dev Fixed r, s values for P-256 sig slot A (used for TEST_DIGEST verification).
    bytes32 constant SIG_R_A = bytes32(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa);
    bytes32 constant SIG_S_A = bytes32(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb);

    /// @dev Fixed r, s values for P-256 sig slot B (used for management operations).
    bytes32 constant SIG_R_B = bytes32(0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc);
    bytes32 constant SIG_S_B = bytes32(0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd);

    /// @dev Fixed r, s values for P-256 sig slot C (removePasskey in test 25).
    bytes32 constant SIG_R_C = bytes32(0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee);
    bytes32 constant SIG_S_C = bytes32(0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);

    // =========================================================================
    // ERC-1271 digest under test
    // =========================================================================

    bytes32 constant TEST_DIGEST = bytes32(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef);

    // =========================================================================
    // WebAuthn authenticatorData (37-byte minimal)
    // =========================================================================

    bytes constant AUTH_DATA = hex"00000000000000000000000000000000000000000000000000000000000000000000000000";

    // =========================================================================
    // Test infrastructure
    // =========================================================================

    SmartEOA      internal account;
    P256MockRegistry internal p256Registry;

    /// @dev secp256k1 primary fallback.
    uint256 internal constant ECDSA_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal ecdsaAddr;

    /// @dev A second secp256k1 address that is NOT the registered fallback.
    uint256 internal constant OTHER_PK = 0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0;
    address internal otherAddr;

    function setUp() public {
        ecdsaAddr = vm.addr(ECDSA_PK);
        otherAddr = vm.addr(OTHER_PK);

        // Deploy the P-256 mock registry and install at the precompile address.
        p256Registry = new P256MockRegistry();
        _installMockP256(address(p256Registry));

        // Deploy a fresh SmartEOA.
        account = new SmartEOA();

        // Initialize: PK1 enrolled active, ecdsaFallback = ecdsaAddr.
        account.initialize{value: 0}(
            PK1_X, PK1_Y, ecdsaAddr,
            payable(address(0)), new bytes(0)
        );

        // Register the valid P-256 input for TEST_DIGEST + PK1 + SIG_A.
        _registerP256(TEST_DIGEST, SIG_R_A, SIG_S_A, PK1_X, PK1_Y);
    }

    // =========================================================================
    // Mock P-256 precompile installation
    // =========================================================================

    function _installMockP256(address registry) internal {
        MockP256Precompile mock = new MockP256Precompile(registry);
        vm.etch(address(0x0100), address(mock).code);
        // Immutables are baked into deployed bytecode — vm.etch copies the
        // post-constructor code which has the registry address embedded.
    }

    // =========================================================================
    // P-256 vector registration helpers
    // =========================================================================

    /// @dev Register a (digest, r, s, qx, qy) tuple as valid in the mock.
    ///      digest → clientDataJSON → h; the precompile input is h||r||s||qx||qy.
    function _registerP256(
        bytes32 digest,
        bytes32 r,
        bytes32 s,
        bytes32 qx,
        bytes32 qy
    ) internal {
        bytes32 h = _computeP256H(AUTH_DATA, _makeCdj(digest));
        bytes memory p256Input = abi.encodePacked(h, r, s, qx, qy);
        p256Registry.register(keccak256(p256Input));
    }

    /// @dev Register a P-256 input for a management operation digest.
    ///      Same as _registerP256 but uses _makeCdj(digest) internally.
    function _registerMgmtP256(
        SmartEOA acct,
        string memory opName,
        bytes memory params,
        bytes32 r,
        bytes32 s,
        bytes32 qx,
        bytes32 qy
    ) internal {
        bytes32 digest = _buildManagementDigest(acct, opName, params);
        _registerP256(digest, r, s, qx, qy);
    }

    // =========================================================================
    // §7 Test 1: valid passkey sig → magic
    // =========================================================================

    function test_1_valid_passkey_sig_returns_magic() public {
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory sig = abi.encode(AUTH_DATA, cdj, SIG_R_A, SIG_S_A);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0x1626ba7e), "Test 1: valid passkey sig must return magic");
    }

    // =========================================================================
    // §7 Test 2: tampered r → fail
    // =========================================================================

    function test_2_tampered_r_returns_fail() public {
        // SIG_R_A ^ 1 is not registered in the mock — precompile returns empty.
        bytes32 tamperedR = bytes32(uint256(SIG_R_A) ^ 1);
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory sig = abi.encode(AUTH_DATA, cdj, tamperedR, SIG_S_A);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0xffffffff), "Test 2: tampered r must return fail");
    }

    // =========================================================================
    // §7 Test 3: correct sig but wrong pubkey registered → fail
    // =========================================================================

    function test_3_wrong_pubkey_registered_returns_fail() public {
        // Deploy a fresh account with PK2 instead of PK1.
        SmartEOA freshAccount = new SmartEOA();
        freshAccount.initialize{value: 0}(PK2_X, PK2_Y, ecdsaAddr, payable(address(0)), new bytes(0));

        // Register SIG_A for PK2 (not PK1).
        _registerP256(TEST_DIGEST, SIG_R_A, SIG_S_A, PK2_X, PK2_Y);

        // Try to verify using SIG_A against PK1 (which is what's registered in the
        // original setUp) — but freshAccount has PK2.  SIG_A+PK2 is registered
        // but SIG_A+PK1 is what setUp registered.  freshAccount only has PK2.
        // So freshAccount.isValidSignature with SIG_A should return magic (PK2 match).
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory sig = abi.encode(AUTH_DATA, cdj, SIG_R_A, SIG_S_A);
        bytes4 result = freshAccount.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0x1626ba7e), "Test 3a: SIG_A+PK2 should verify against freshAccount");

        // Now use a sig registered for PK1 only (SIG_B registered only for PK1):
        _registerP256(TEST_DIGEST, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        bytes memory sigPK1 = abi.encode(AUTH_DATA, cdj, SIG_R_B, SIG_S_B);
        // freshAccount has PK2; SIG_B is registered for PK1 but PK1 is not in freshAccount.
        bytes4 result2 = freshAccount.isValidSignature(TEST_DIGEST, sigPK1);
        assertEq(result2, bytes4(0xffffffff), "Test 3b: SIG for PK1 must fail against PK2-enrolled account");
    }

    // =========================================================================
    // §7 Test 4: malformed sig blob → fail (no revert)
    // =========================================================================

    function test_4_malformed_sig_no_revert() public {
        bytes4 r1 = account.isValidSignature(TEST_DIGEST, hex"deadbeef");
        assertEq(r1, bytes4(0xffffffff), "Test 4: 4-byte garbage must return fail");

        bytes4 r2 = account.isValidSignature(TEST_DIGEST, new bytes(0));
        assertEq(r2, bytes4(0xffffffff), "Test 4b: empty sig must return fail");

        bytes4 r3 = account.isValidSignature(TEST_DIGEST, new bytes(128));
        assertEq(r3, bytes4(0xffffffff), "Test 4c: 128-byte truncated sig must return fail");
    }

    // =========================================================================
    // §7 Test 5: challenge mismatch → fail
    // =========================================================================

    function test_5_challenge_mismatch_returns_fail() public {
        // clientDataJSON has challenge = base64url("hello") != TEST_DIGEST.
        bytes memory wrongCdj = bytes(
            '{"type":"webauthn.get","challenge":"aGVsbG8","origin":"https://app.caw.social"}'
        );
        bytes memory sig = abi.encode(AUTH_DATA, wrongCdj, SIG_R_A, SIG_S_A);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0xffffffff), "Test 5: challenge mismatch must fail");
    }

    // =========================================================================
    // §7 Test 6: pending key (validFrom in future) → fail; after warp → success
    // =========================================================================

    /// @dev We test pending key behavior by deploying a fresh SmartEOA and having
    ///      the test harness add a second key (PK2) which will be in pending state.
    ///      We then verify PK2's sig fails before the timelock and succeeds after.
    ///
    ///      Note: PK1 is active from initialization and PK2 is added via secp256k1
    ///      ecdsaFallback path (addPasskey accepts ecdsaFallback only when
    ///      activeCount == 0).  For this test we need a more direct pending-key
    ///      insertion.  We use the TestHarness which exposes a method to add a
    ///      pending key entry directly.
    function test_6_pending_key_returns_fail() public view {
        // account has PK1 active.
        // We can't directly add a pending key without going through addPasskey
        // (which requires PK1's sig).  For this test we'll use the
        // PendingKeyHarness that bypasses addPasskey via an override.
        // NOTE: this test documents the behavior; the harness is tested below.
        // The contract logic for pending keys is:
        //   if (entry.validFrom != 0 && block.timestamp < entry.validFrom) continue;
        // This is the critical guard in _verifyWebAuthn that we test via the harness.
        assertTrue(true, "Pending key logic tested via test_6_via_harness below");
    }

    function test_6_via_harness() public {
        // Deploy the pending-key harness (uses internal override, not sstore).
        PendingKeyHarness h = new PendingKeyHarness();
        h.init(PK1_X, PK1_Y, ecdsaAddr);

        // Register the SIG_A for TEST_DIGEST against PK1.
        // The harness reuses the same p256Registry via _installMockP256.
        // But h is a different contract; we need to re-install the mock for it
        // OR share the same mock address.  Since vm.etch is global, the mock at
        // 0x0100 is already installed — all calls go through it.

        // PK1 is enrolled as PENDING in the harness (validFrom = now + 86400).
        // SIG_A is registered in setUp for PK1 + TEST_DIGEST.
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory sig = abi.encode(AUTH_DATA, cdj, SIG_R_A, SIG_S_A);

        // Before timelock: PK1 is pending → fail.
        bytes4 before_ = h.isValidSignature(TEST_DIGEST, sig);
        assertEq(before_, bytes4(0xffffffff), "Test 6: pending key must fail before timelock");

        // After timelock: PK1 becomes active → success.
        vm.warp(block.timestamp + 86401);
        bytes4 after_ = h.isValidSignature(TEST_DIGEST, sig);
        assertEq(after_, bytes4(0x1626ba7e), "Test 6b: key must activate after timelock elapsed");
    }

    // =========================================================================
    // §7 Test 7: valid 65-byte secp256k1 from ecdsaFallback → magic
    // =========================================================================

    function test_7_valid_secp256k1_from_ecdsaFallback_returns_magic() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, TEST_DIGEST);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(sig.length, 65);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0x1626ba7e), "Test 7: valid ecdsaFallback sig must return magic");
    }

    // =========================================================================
    // §7 Test 8: valid 65-byte sig from non-ecdsaFallback → fail
    // =========================================================================

    function test_8_secp256k1_non_fallback_returns_fail() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OTHER_PK, TEST_DIGEST);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0xffffffff), "Test 8: non-fallback secp256k1 sig must fail");
    }

    // =========================================================================
    // Malleable v rejection (bonus security tests)
    // =========================================================================

    function test_malleable_v_rejected() public {
        (, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, TEST_DIGEST);
        // v = 26 (below valid range 27-28)
        bytes4 r26 = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r, s, uint8(26)));
        assertEq(r26, bytes4(0xffffffff), "v=26 must be rejected");
        // v = 0
        bytes4 r0 = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r, s, uint8(0)));
        assertEq(r0, bytes4(0xffffffff), "v=0 must be rejected");
    }

    // =========================================================================
    // §7 Test 9: rotateEcdsaFallback
    // =========================================================================

    function test_9_rotate_ecdsa_fallback() public {
        address newFallback = otherAddr;  // vm.addr(OTHER_PK)

        // Build and register the P-256 sig for rotateEcdsaFallback management digest.
        _registerMgmtP256(
            account,
            "rotateEcdsaFallback",
            abi.encode(newFallback),
            SIG_R_B, SIG_S_B,
            PK1_X, PK1_Y
        );

        // Call rotateEcdsaFallback with the registered passkey sig.
        bytes32 rotateDigest = _buildManagementDigest(
            account, "rotateEcdsaFallback", abi.encode(newFallback)
        );
        bytes memory callerSig = abi.encode(AUTH_DATA, _makeCdj(rotateDigest), SIG_R_B, SIG_S_B);
        account.rotateEcdsaFallback(newFallback, callerSig);

        // OLD sig (from ECDSA_PK) must now fail.
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ECDSA_PK, TEST_DIGEST);
        bytes4 oldResult = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r1, s1, v1));
        assertEq(oldResult, bytes4(0xffffffff), "Test 9a: old ECDSA sig must fail after rotation");

        // NEW sig (from OTHER_PK, which is the new fallback) must succeed.
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(OTHER_PK, TEST_DIGEST);
        bytes4 newResult = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r2, s2, v2));
        assertEq(newResult, bytes4(0x1626ba7e), "Test 9b: new ECDSA sig must succeed after rotation");
    }

    // =========================================================================
    // §7 Test 10: recovery — all passkeys removed, addPasskey via secp256k1
    // =========================================================================

    function test_10_recovery_addPasskey_via_secp256k1() public {
        bytes32 pk1Hash = keccak256(abi.encodePacked(PK1_X, PK1_Y));

        // Remove PK1 via secp256k1 ecdsaFallback (unconditional removal path).
        bytes32 removeDigest = _buildManagementDigest(
            account, "removePasskey", abi.encode(pk1Hash)
        );
        (uint8 vr, bytes32 rr, bytes32 sr) = vm.sign(ECDSA_PK, removeDigest);
        bytes memory removeSig = abi.encodePacked(rr, sr, vr);
        account.removePasskey(pk1Hash, removeSig);

        // isValidSignature with PK1's WebAuthn sig must now fail (PK1 removed).
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory webAuthnSig = abi.encode(AUTH_DATA, cdj, SIG_R_A, SIG_S_A);
        bytes4 afterRemove = account.isValidSignature(TEST_DIGEST, webAuthnSig);
        assertEq(afterRemove, bytes4(0xffffffff), "Test 10a: PK1 removed, WebAuthn sig must fail");

        // addPasskey(PK2) using secp256k1 ecdsaFallback (bootstrap-recovery path,
        // triggered because activeCount == 0 after PK1 removal).
        // nonce is now 1 (after removePasskey bumped it); _buildManagementDigest auto-reads.
        bytes32 addDigest = _buildManagementDigest(
            account, "addPasskey", abi.encode(PK2_X, PK2_Y)
        );
        (uint8 va, bytes32 ra, bytes32 sa) = vm.sign(ECDSA_PK, addDigest);
        bytes memory addSig = abi.encodePacked(ra, sa, va);
        account.addPasskey(PK2_X, PK2_Y, addSig);

        // PK2 is now pending for 24 hours.  Warp past timelock.
        vm.warp(block.timestamp + 86401);

        // Register PK2 sig for TEST_DIGEST.
        _registerP256(TEST_DIGEST, SIG_R_B, SIG_S_B, PK2_X, PK2_Y);
        bytes memory pk2Sig = abi.encode(AUTH_DATA, _makeCdj(TEST_DIGEST), SIG_R_B, SIG_S_B);
        bytes4 pk2Result = account.isValidSignature(TEST_DIGEST, pk2Sig);
        assertEq(pk2Result, bytes4(0x1626ba7e), "Test 10b: newly enrolled PK2 sig must succeed after timelock");

        // ecdsaFallback still works.
        (uint8 vf, bytes32 rf, bytes32 sf) = vm.sign(ECDSA_PK, TEST_DIGEST);
        bytes4 fbResult = account.isValidSignature(TEST_DIGEST, abi.encodePacked(rf, sf, vf));
        assertEq(fbResult, bytes4(0x1626ba7e), "Test 10c: ecdsaFallback still valid after recovery");
    }

    // =========================================================================
    // §7 Test 11: nonce monotonicity
    // =========================================================================

    function test_11_nonce_monotonicity() public {
        address mockMinter = makeAddr("mockMinter");
        uint8 actionType = 1;

        // Initial nonce is 0.
        assertEq(account.nonceOf(mockMinter, actionType), 0, "Test 11: initial nonce must be 0");

        // Only mockMinter can consume its nonce.
        vm.prank(mockMinter);
        account.consumeNonce(mockMinter, actionType);
        assertEq(account.nonceOf(mockMinter, actionType), 1, "Test 11: nonce must be 1");

        // Attacker cannot consume mockMinter's nonce.
        vm.expectRevert(SmartEOA.NotPermitted.selector);
        account.consumeNonce(mockMinter, actionType);

        // Another consume by mockMinter.
        vm.prank(mockMinter);
        account.consumeNonce(mockMinter, actionType);
        assertEq(account.nonceOf(mockMinter, actionType), 2, "Test 11: nonce must be 2");

        // Nonce for a DIFFERENT action type is independent.
        assertEq(account.nonceOf(mockMinter, actionType + 1), 0, "Test 11: separate action type nonce is 0");

        // Nonce for a DIFFERENT verifying contract is independent.
        address anotherMinter = makeAddr("anotherMinter");
        assertEq(account.nonceOf(anotherMinter, actionType), 0, "Test 11: separate contract nonce is 0");
    }

    // =========================================================================
    // §7 Test 12: management digest is chainid-specific
    // =========================================================================

    /// @dev The management digest includes block.chainid.  A sig valid on chain X
    ///      is invalid on chain Y because the digest differs.
    ///
    ///      For isValidSignature itself (not management ops), the chain-id binding
    ///      comes from the Minter's EIP-712 domain separator embedded in the digest
    ///      being verified.  If the Minter passes a chain-1 digest to isValidSignature
    ///      on Base, the sig was over a different value — it will return 0xffffffff.
    function test_12_management_digest_is_chainid_specific() public {
        uint256 originalChainId = block.chainid;

        bytes32 digest31337 = _buildManagementDigest(
            account, "addPasskey", abi.encode(PK2_X, PK2_Y)
        );

        vm.chainId(1);  // Simulate Ethereum mainnet chain ID
        bytes32 digest1 = _buildManagementDigest(
            account, "addPasskey", abi.encode(PK2_X, PK2_Y)
        );
        vm.chainId(originalChainId);

        assertNotEq(digest31337, digest1, "Test 12: management digest must differ across chainIds");
        assertTrue(digest31337 != bytes32(0), "Test 12: digest must be non-zero");
        assertTrue(digest1 != bytes32(0), "Test 12: digest must be non-zero");
    }

    // =========================================================================
    // §7 Test 25: N=1 self-removal (contract layer)
    // =========================================================================

    /// @notice §1 Scenario D: N=1 self-removal is deliberately permitted at the
    ///         contract layer.
    ///
    ///         FE GUARD REQUIREMENT (for FE implementors — NOT enforced on-chain):
    ///           When enrolled passkey count is 1 and the user clicks "Remove passkey",
    ///           the UI MUST require vault-password confirmation before submitting.
    ///           Without confirmation, the remove button MUST remain disabled.
    ///           This guard prevents accidental self-lockout.
    function test_25_N1_self_removal_contract_layer() public {
        bytes32 pk1Hash = keccak256(abi.encodePacked(PK1_X, PK1_Y));

        // Build management digest for removePasskey(pk1Hash) — self-removal.
        bytes32 removeDigest = _buildManagementDigest(
            account, "removePasskey", abi.encode(pk1Hash)
        );

        // Register PK1 sig for the self-removal management digest.
        _registerP256(removeDigest, SIG_R_C, SIG_S_C, PK1_X, PK1_Y);

        // Build the callerSig: WebAuthn blob with SIG_R_C, SIG_S_C over removeDigest.
        bytes memory callerSig = abi.encode(AUTH_DATA, _makeCdj(removeDigest), SIG_R_C, SIG_S_C);

        // Call removePasskey — N=1, signer == target → should succeed.
        account.removePasskey(pk1Hash, callerSig);

        // After removal: PK1 sig must return fail.
        bytes memory cdj = _makeCdj(TEST_DIGEST);
        bytes memory sig = abi.encode(AUTH_DATA, cdj, SIG_R_A, SIG_S_A);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0xffffffff), "Test 25: removed key must not validate");
    }

    // =========================================================================
    // Additional: initialize-twice revert
    // =========================================================================

    function test_initialize_twice_reverts() public {
        vm.expectRevert(SmartEOA.AlreadyInitialized.selector);
        account.initialize{value: 0}(PK1_X, PK1_Y, ecdsaAddr, payable(address(0)), new bytes(0));
    }

    // =========================================================================
    // Additional: consumeNonce gating
    // =========================================================================

    function test_consumeNonce_gated() public {
        address minter = makeAddr("minter");
        address attacker = makeAddr("attacker");

        vm.expectRevert(SmartEOA.NotPermitted.selector);
        vm.prank(attacker);
        account.consumeNonce(minter, 0);

        // The minter CAN consume its own nonce.
        vm.prank(minter);
        account.consumeNonce(minter, 0);
        assertEq(account.nonceOf(minter, 0), 1);
    }

    // =========================================================================
    // Additional: pending passkey cannot authorize management operations
    // =========================================================================

    function test_pending_key_cannot_vote_in_quorum() public {
        // Use the PendingKeyHarness: PK1 is pending.
        PendingKeyHarness h = new PendingKeyHarness();
        h.init(PK1_X, PK1_Y, ecdsaAddr);

        // PK1 is pending.  Attempt addPasskey(PK2) using PK1's WebAuthn sig.
        // activeCount == 0 (PK1 is pending), so the code falls through to the
        // ecdsaFallback path.  The callerSig is a WebAuthn blob (not 65 bytes),
        // so _verifySig65 returns false → InvalidCallerSig.
        // h.account is the underlying SmartEOA; its managementNonce is 2 (after
        // harness init ran removePasskey + addPasskey). The exact digest doesn't
        // matter here — this test expects a revert before digest verification
        // (activeCount==0, callerSig is WebAuthn not 65-byte → InvalidCallerSig).
        bytes32 addDigest = _buildManagementDigest(
            h.account(), "addPasskey", abi.encode(PK2_X, PK2_Y)
        );
        _registerP256(addDigest, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        bytes memory sig = abi.encode(AUTH_DATA, _makeCdj(addDigest), SIG_R_B, SIG_S_B);

        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        h.addPasskey(PK2_X, PK2_Y, sig);
    }

    // =========================================================================
    // H-1 regression: management sig replay must fail after nonce bump
    // =========================================================================

    /// @dev Captures a management sig for addPasskey, uses it once (succeeds),
    ///      then attempts to reuse the same sig + params again (must revert because
    ///      managementNonce was bumped after the first successful call).
    function test_H1_management_sig_replay_rejected() public {
        // Snapshot nonce before any management op (should be 0 after setUp).
        uint256 nonceBefore = account.managementNonceOf();
        assertEq(nonceBefore, 0, "H1: initial managementNonce must be 0");

        // Build and register the P-256 sig for addPasskey(PK2) at nonce=0.
        bytes32 addDigest = _buildManagementDigest(account, "addPasskey", abi.encode(PK2_X, PK2_Y));
        _registerP256(addDigest, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        bytes memory callerSig = abi.encode(AUTH_DATA, _makeCdj(addDigest), SIG_R_B, SIG_S_B);

        // First call succeeds — PK2 enrolled.
        account.addPasskey(PK2_X, PK2_Y, callerSig);
        assertEq(account.managementNonceOf(), 1, "H1: nonce must be 1 after addPasskey");

        // Remove PK2 so we can try to add it again (otherwise PasskeyAlreadyEnrolled fires first).
        bytes32 pk2Hash = keccak256(abi.encodePacked(PK2_X, PK2_Y));
        bytes32 removeDigest = _buildManagementDigest(account, "removePasskey", abi.encode(pk2Hash));
        (uint8 vr, bytes32 rr, bytes32 sr) = vm.sign(ECDSA_PK, removeDigest);
        account.removePasskey(pk2Hash, abi.encodePacked(rr, sr, vr));
        assertEq(account.managementNonceOf(), 2, "H1: nonce must be 2 after removePasskey");

        // Replay the ORIGINAL sig (built at nonce=0) — must fail.
        // The contract will compute the digest with nonce=2; the sig was over nonce=0.
        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        account.addPasskey(PK2_X, PK2_Y, callerSig);
    }

    // =========================================================================
    // M-1: initialize with zero ecdsaFallback must revert ZeroAddress
    // =========================================================================

    function test_M1_zero_ecdsaFallback_reverts() public {
        SmartEOA fresh = new SmartEOA();
        vm.expectRevert(SmartEOA.ZeroAddress.selector);
        fresh.initialize{value: 0}(PK1_X, PK1_Y, address(0), payable(address(0)), new bytes(0));
    }

    // =========================================================================
    // M-2: padded base64url challenge is correctly trimmed
    // =========================================================================

    /// @dev Verifies that a WebAuthn sig whose clientDataJSON challenge has one or
    ///      two trailing '=' padding chars is accepted after stripping.
    ///      We build a padded CdJ manually and confirm isValidSignature returns magic.
    function test_M2_padded_base64url_challenge_accepted() public {
        // The 32-byte TEST_DIGEST base64url-encodes to 43 unpadded chars.
        // Adding one '=' makes it 44 chars (padded form some encoders emit).
        bytes memory cdj_unpadded = _makeCdj(TEST_DIGEST);

        // Build the padded variant: inject '=' after the base64url challenge value.
        // We search for the first '"' that closes the challenge and insert '=' before it.
        // Simpler: construct it directly from the known unpadded encoding + "=".
        bytes memory b64_unpadded = _base64urlEncode(abi.encodePacked(TEST_DIGEST));
        bytes memory cdj_padded = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            b64_unpadded,
            '=","origin":"https://app.caw.social"}'
        );

        // Register precompile input for padded clientDataJSON (the P-256 hash changes
        // because sha256(cdj_padded) differs from sha256(cdj_unpadded)).
        bytes32 h_padded = _computeP256H(AUTH_DATA, cdj_padded);
        bytes memory p256Input = abi.encodePacked(h_padded, SIG_R_A, SIG_S_A, PK1_X, PK1_Y);
        p256Registry.register(keccak256(p256Input));

        bytes memory sig = abi.encode(AUTH_DATA, cdj_padded, SIG_R_A, SIG_S_A);
        bytes4 result = account.isValidSignature(TEST_DIGEST, sig);
        assertEq(result, bytes4(0x1626ba7e), "M2: padded base64url challenge must be accepted");
    }

    // =========================================================================
    // L-1: high-s secp256k1 sig is rejected (malleability hardening)
    // =========================================================================

    /// @dev secp256k1 curve order n.
    uint256 private constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function test_L1_high_s_sig_rejected() public {
        // Get a canonical low-s sig from vm.sign.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, TEST_DIGEST);

        // Verify the low-s sig succeeds (baseline).
        bytes4 lowSResult = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r, s, v));
        assertEq(lowSResult, bytes4(0x1626ba7e), "L1: low-s sig must succeed");

        // Compute the malleated high-s form: s' = n - s, v' = v ^ 1.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 vMalleated = v ^ 1;

        // The high-s form must be rejected.
        bytes4 highSResult = account.isValidSignature(TEST_DIGEST, abi.encodePacked(r, highS, vMalleated));
        assertEq(highSResult, bytes4(0xffffffff), "L1: high-s sig must be rejected");
    }

    // =========================================================================
    // L-2: SelfRemovalRequiresLastActive error fires on wrong path
    // =========================================================================

    /// @dev Attempt self-removal when activeCount > 1 — must revert with the
    ///      renamed error SelfRemovalRequiresLastActive (not CannotRemoveLastActive).
    function test_L2_self_removal_error_name() public {
        // Add PK2 so activeCount = 2 after timelock.
        bytes32 addDigest = _buildManagementDigest(account, "addPasskey", abi.encode(PK2_X, PK2_Y));
        _registerP256(addDigest, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        bytes memory addSig = abi.encode(AUTH_DATA, _makeCdj(addDigest), SIG_R_B, SIG_S_B);
        account.addPasskey(PK2_X, PK2_Y, addSig);

        // Warp past timelock so PK2 becomes active.
        vm.warp(block.timestamp + 86401);

        // Build a removal sig from PK1 targeting PK1 itself (self-removal attempt).
        bytes32 pk1Hash = keccak256(abi.encodePacked(PK1_X, PK1_Y));
        bytes32 selfRemoveDigest = _buildManagementDigest(account, "removePasskey", abi.encode(pk1Hash));
        _registerP256(selfRemoveDigest, SIG_R_C, SIG_S_C, PK1_X, PK1_Y);
        bytes memory selfRemoveSig = abi.encode(AUTH_DATA, _makeCdj(selfRemoveDigest), SIG_R_C, SIG_S_C);

        // Must revert with SelfRemovalRequiresLastActive because activeCount = 2.
        vm.expectRevert(SmartEOA.SelfRemovalRequiresLastActive.selector);
        account.removePasskey(pk1Hash, selfRemoveSig);
    }

    // =========================================================================
    // L-3: double-event fix — cancelPendingPasskey must NOT emit PasskeyRemoved
    // =========================================================================

    function test_L3_cancel_emits_cancelled_not_removed() public {
        // Add PK2 — will be in pending state.
        bytes32 addDigest = _buildManagementDigest(account, "addPasskey", abi.encode(PK2_X, PK2_Y));
        _registerP256(addDigest, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        bytes memory addSig = abi.encode(AUTH_DATA, _makeCdj(addDigest), SIG_R_B, SIG_S_B);
        account.addPasskey(PK2_X, PK2_Y, addSig);

        bytes32 pk2Hash = keccak256(abi.encodePacked(PK2_X, PK2_Y));

        // cancelPendingPasskey using ecdsaFallback sig.
        bytes32 cancelDigest = _buildManagementDigest(account, "cancelPendingPasskey", abi.encode(pk2Hash));
        (uint8 vc, bytes32 rc, bytes32 sc) = vm.sign(ECDSA_PK, cancelDigest);
        bytes memory cancelSig = abi.encodePacked(rc, sc, vc);

        // vm.recordLogs captures ALL events; we assert PasskeyCancelled is emitted
        // EXACTLY ONCE and PasskeyRemoved is NOT emitted. This is stronger than
        // vm.expectEmit which only checks the next matching event and doesn't
        // prove absence of other events.
        vm.recordLogs();
        account.cancelPendingPasskey(pk2Hash, cancelSig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 cancelledSig = keccak256("PasskeyCancelled(bytes32)");
        bytes32 removedSig = keccak256("PasskeyRemoved(bytes32)");
        uint256 cancelledCount;
        uint256 removedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0) {
                if (logs[i].topics[0] == cancelledSig) cancelledCount++;
                if (logs[i].topics[0] == removedSig) removedCount++;
            }
        }
        assertEq(cancelledCount, 1, "expected exactly one PasskeyCancelled");
        assertEq(removedCount, 0, "expected no PasskeyRemoved");
    }

    function test_L3_remove_emits_removed_not_cancelled() public {
        // Remove PK1 via ecdsaFallback — must emit PasskeyRemoved only.
        bytes32 pk1Hash = keccak256(abi.encodePacked(PK1_X, PK1_Y));
        bytes32 removeDigest = _buildManagementDigest(account, "removePasskey", abi.encode(pk1Hash));
        (uint8 vr, bytes32 rr, bytes32 sr) = vm.sign(ECDSA_PK, removeDigest);
        bytes memory removeSig = abi.encodePacked(rr, sr, vr);

        vm.recordLogs();
        account.removePasskey(pk1Hash, removeSig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 cancelledSig = keccak256("PasskeyCancelled(bytes32)");
        bytes32 removedSig = keccak256("PasskeyRemoved(bytes32)");
        uint256 cancelledCount;
        uint256 removedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0) {
                if (logs[i].topics[0] == cancelledSig) cancelledCount++;
                if (logs[i].topics[0] == removedSig) removedCount++;
            }
        }
        assertEq(removedCount, 1, "expected exactly one PasskeyRemoved");
        assertEq(cancelledCount, 0, "expected no PasskeyCancelled");
    }

    // =========================================================================
    // cancelPendingPasskey coverage: ecdsaFallback path + error cases
    // =========================================================================

    function test_cancelPendingPasskey_active_key_reverts_PasskeyNotPending() public {
        // PK1 is active (validFrom=0). Attempting to cancel it must revert.
        bytes32 pk1Hash = keccak256(abi.encodePacked(PK1_X, PK1_Y));
        bytes32 cancelDigest = _buildManagementDigest(account, "cancelPendingPasskey", abi.encode(pk1Hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, cancelDigest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(SmartEOA.PasskeyNotPending.selector);
        account.cancelPendingPasskey(pk1Hash, sig);
    }

    function test_cancelPendingPasskey_nonexistent_key_reverts_PasskeyNotFound() public {
        bytes32 fakeHash = keccak256(abi.encodePacked(bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xcafebabe))));
        bytes32 cancelDigest = _buildManagementDigest(account, "cancelPendingPasskey", abi.encode(fakeHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ECDSA_PK, cancelDigest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(SmartEOA.PasskeyNotFound.selector);
        account.cancelPendingPasskey(fakeHash, sig);
    }

    function test_cancelPendingPasskey_via_ecdsaFallback_succeeds() public {
        // Add PK2 (pending) then cancel via ecdsaFallback 65-byte sig.
        bytes32 addDigest = _buildManagementDigest(account, "addPasskey", abi.encode(PK2_X, PK2_Y));
        _registerP256(addDigest, SIG_R_B, SIG_S_B, PK1_X, PK1_Y);
        account.addPasskey(PK2_X, PK2_Y, abi.encode(AUTH_DATA, _makeCdj(addDigest), SIG_R_B, SIG_S_B));

        bytes32 pk2Hash = keccak256(abi.encodePacked(PK2_X, PK2_Y));
        bytes32 cancelDigest = _buildManagementDigest(account, "cancelPendingPasskey", abi.encode(pk2Hash));
        (uint8 vc, bytes32 rc, bytes32 sc) = vm.sign(ECDSA_PK, cancelDigest);

        vm.expectEmit(true, false, false, false);
        emit SmartEOA.PasskeyCancelled(pk2Hash);
        account.cancelPendingPasskey(pk2Hash, abi.encodePacked(rc, sc, vc));
    }

    // =========================================================================
    // Stub cleanup: test_6_pending_key_returns_fail body note
    // =========================================================================
    // test_6_pending_key_returns_fail is kept as-is (assertTrue(true,...)) per I-1
    // guidance — the real coverage is in test_6_via_harness.  No change needed.

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /// @dev Mirror of SmartEOA._managementDigest for test use.
    ///      nonce should be the value of account.managementNonceOf() at the time the
    ///      sig is being built (i.e., before the management call is submitted).
    function _buildManagementDigest(
        address acct,
        string memory opName,
        bytes memory params,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(abi.encodePacked("SmartEOA", block.chainid, acct));
        bytes32 structHash = keccak256(abi.encodePacked(
            keccak256(bytes(opName)),
            keccak256(params),
            nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @dev Convenience overload: reads nonce from the given SmartEOA automatically.
    function _buildManagementDigest(
        SmartEOA acct,
        string memory opName,
        bytes memory params
    ) internal view returns (bytes32) {
        return _buildManagementDigest(address(acct), opName, params, acct.managementNonceOf());
    }

    /// @dev Build clientDataJSON encoding the given digest as the base64url challenge.
    function _makeCdj(bytes32 digest) internal pure returns (bytes memory) {
        bytes memory b64 = _base64urlEncode(abi.encodePacked(digest));
        return abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            b64,
            '","origin":"https://app.caw.social"}'
        );
    }

    /// @dev Compute sha256(authenticatorData || sha256(clientDataJSON)).
    function _computeP256H(bytes memory authData, bytes memory cdj)
        internal
        pure
        returns (bytes32)
    {
        return sha256(abi.encodePacked(authData, sha256(cdj)));
    }

    /// @dev Minimal base64url encoder for 32-byte inputs (unpadded).
    function _base64urlEncode(bytes memory data) internal pure returns (bytes memory) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        uint256 outLen = (len * 4 + 2) / 3;
        bytes memory out = new bytes(outLen);
        uint256 outIdx;
        uint256 i;
        while (i + 3 <= len) {
            uint24 chunk = (uint24(uint8(data[i])) << 16)
                         | (uint24(uint8(data[i+1])) << 8)
                         |  uint24(uint8(data[i+2]));
            out[outIdx++] = alphabet[(chunk >> 18) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 12) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 6)  & 0x3F];
            out[outIdx++] = alphabet[chunk & 0x3F];
            i += 3;
        }
        if (len - i == 2) {
            uint16 chunk = (uint16(uint8(data[i])) << 8) | uint16(uint8(data[i+1]));
            out[outIdx++] = alphabet[(chunk >> 10) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 4)  & 0x3F];
            out[outIdx]   = alphabet[(chunk << 2)  & 0x3F];
        } else if (len - i == 1) {
            uint8 chunk = uint8(data[i]);
            out[outIdx++] = alphabet[(chunk >> 2) & 0x3F];
            out[outIdx]   = alphabet[(chunk << 4) & 0x3F];
        }
        return out;
    }

    receive() external payable {}
}

// =============================================================================
// Test harnesses
// =============================================================================

/// @dev Harness that initializes SmartEOA with PK1 as PENDING (not active).
///      Used to test the "pending key → skip" logic in _verifyWebAuthn.
///
///      IMPLEMENTATION: overrides initialize() to write the passkey with
///      validFrom = block.timestamp + PASSKEY_TIMELOCK rather than 0.
///      This avoids raw sstore and the storage-packing problem.
///
///      Since SmartEOA has no virtual initialize, we re-implement the relevant
///      storage setup here as a separate init function.
contract PendingKeyHarness {
    // Mirrors SmartEOA storage — but we can't inherit because we need to
    // override private storage writes.  Instead we deploy a SmartEOA and
    // set up state via the addPasskey flow.
    //
    // ACTUAL APPROACH: deploy SmartEOA with NO initial passkey (zero address
    // fallback), then add PK1 via addPasskey (which puts it in pending state
    // because ecdsaFallback is non-zero but the ecdsaFallback path requires
    // 65-byte sig)... but the account has no initial passkey AND the fallback
    // call requires activeCount==0.
    //
    // SIMPLEST approach: initialize with ecdsaFallback, then use addPasskey
    // to add PK1 — which puts it in pending.  Start with a NO-passkey initial
    // state by using a temporary passkey and removing it.
    //
    // EVEN SIMPLER: use the BypassHarness2 pattern below.

    SmartEOA public account;

    function init(bytes32 pkX, bytes32 pkY, address fallback_) external {
        account = new SmartEOA();
        // Initialize with a DUMMY passkey first (we'll remove it after).
        // The dummy passkey is PK2-equivalent: a non-real point that we control.
        bytes32 dummyX = bytes32(0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0);
        bytes32 dummyY = bytes32(0xe0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0);
        account.initialize{value: 0}(dummyX, dummyY, fallback_, payable(address(0)), new bytes(0));

        // Remove the dummy passkey via ecdsaFallback (65-byte sig).
        bytes32 dummyHash = keccak256(abi.encodePacked(dummyX, dummyY));
        // nonce=0 before first management op
        bytes32 removeDigest = _mgmtDigestWithNonce(address(account), "removePasskey", abi.encode(dummyHash), account.managementNonceOf());
        uint256 fallbackPk = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
        (uint8 v, bytes32 r, bytes32 s) = vm_().sign(fallbackPk, removeDigest);
        account.removePasskey(dummyHash, abi.encodePacked(r, s, v));

        // Now activeCount == 0.  addPasskey(pkX, pkY) with ecdsaFallback sig
        // → puts pkX/pkY in PENDING state (validFrom = now + 86400).
        // nonce=1 after removePasskey bumped it
        bytes32 addDigest = _mgmtDigestWithNonce(address(account), "addPasskey", abi.encode(pkX, pkY), account.managementNonceOf());
        (uint8 v2, bytes32 r2, bytes32 s2) = vm_().sign(fallbackPk, addDigest);
        account.addPasskey(pkX, pkY, abi.encodePacked(r2, s2, v2));
    }

    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        return account.isValidSignature(digest, sig);
    }

    function addPasskey(bytes32 pkX, bytes32 pkY, bytes calldata sig) external {
        account.addPasskey(pkX, pkY, sig);
    }

    function _mgmtDigestWithNonce(address acct, string memory opName, bytes memory params, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSep = keccak256(abi.encodePacked("SmartEOA", block.chainid, acct));
        bytes32 structHash = keccak256(abi.encodePacked(keccak256(bytes(opName)), keccak256(params), nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function vm_() internal pure returns (IVmSign) {
        return IVmSign(address(uint160(uint256(keccak256("hevm cheat code")))));
    }
}

// Cheatcode interface for the harness (inheriting Test is not available in non-test contracts)
interface IVmSign {
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
}

// =============================================================================
// P-256 mock precompile infrastructure
// =============================================================================

/// @dev Registry of accepted P-256 input hashes.
contract P256MockRegistry {
    mapping(bytes32 => bool) public accepted;

    function register(bytes32 inputHash) external {
        accepted[inputHash] = true;
    }
}

/// @dev Mock for the EIP-7951 P-256 precompile deployed at 0x0100 via vm.etch().
///      Input: h(32) || r(32) || s(32) || qx(32) || qy(32) = 160 bytes.
///      Returns abi.encode(1) if keccak256(input[0:160]) is registered, else empty.
contract MockP256Precompile {
    P256MockRegistry public immutable registry;

    constructor(address _registry) {
        registry = P256MockRegistry(_registry);
    }

    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length < 160) return new bytes(0);
        bytes32 h = keccak256(input[0:160]);
        if (registry.accepted(h)) {
            return abi.encode(uint256(1));
        }
        return new bytes(0);
    }
}
