// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileL2.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

/// @title SessionRegisterFuzzTest
/// @notice Fuzz the EIP-712 `registerSession` (by-sig) path.
///         CawProfileL2 is OApp-based — we deploy with `MockLayerZeroEndpoint`
///         so the constructor's OAppCore call doesn't revert.
///
/// @dev Invariants checked:
///        1. `expiry <= block.timestamp` always reverts ("Already expired").
///        2. A previously-issued sig replayed after a successful register
///           reverts (sessionNonce monotonicity / replay protection).
///        3. Tampering with any signed field flips the recovered signer,
///           leading to a "Invalid nonce" revert (because the wrong-signer
///           branch will see a non-matching nonce in their slot).
///        4. WITHDRAW (bit 6) cannot be delegated.
///        5. Successful register bumps `sessionNonce` by exactly 1.
contract SessionRegisterFuzzTest is Test {
    CawProfileL2 internal profile;
    MockLayerZeroEndpoint internal lzEndpoint;

    bytes32 internal DOMAIN;
    bytes32 internal constant DELEGATION_TYPEHASH = keccak256(
        "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
    );

    // ------------------------------------------------------------------
    // setUp
    // ------------------------------------------------------------------
    function setUp() public {
        // EIDs are arbitrary; we don't actually send LZ messages.
        lzEndpoint = new MockLayerZeroEndpoint(40245);
        profile = new CawProfileL2(30101, address(lzEndpoint));
        DOMAIN = profile.eip712DomainHash();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _digest(
        address sessionKey,
        uint64 expiry,
        uint8 scopeBitmap,
        uint256 spendLimit,
        uint64 perActionTipRate,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            DELEGATION_TYPEHASH,
            sessionKey,
            expiry,
            scopeBitmap,
            spendLimit,
            perActionTipRate,
            nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN, structHash));
    }

    function _sign(uint256 pk, bytes32 dgst) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(pk, dgst);
    }

    // ------------------------------------------------------------------
    // Property 1: expired registration is rejected.
    // ------------------------------------------------------------------
    function testFuzz_RejectsExpired(uint256 pk, address sessionKey, uint8 scope, uint256 spendLimit, uint64 tipRate, uint64 expiry) public {
        pk = bound(pk, 1, type(uint128).max);
        vm.assume(sessionKey != address(0));
        // Force expiry into the past or now.
        expiry = uint64(bound(uint256(expiry), 0, block.timestamp));
        // Avoid the WITHDRAW-delegation path; we test it separately.
        scope = uint8(bound(uint256(scope), 0, 0xFF)) & 0xBF;

        uint256 nonce = profile.sessionNonce(vm.addr(pk));
        bytes32 d = _digest(sessionKey, expiry, scope, spendLimit, tipRate, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, d);

        vm.expectRevert(bytes("expired"));
        profile.registerSession(sessionKey, expiry, scope, spendLimit, tipRate, nonce, v, r, s);
    }

    // ------------------------------------------------------------------
    // Property 2: replay protection — second submit with the same sig
    //             fails because the signer's nonce was bumped.
    // ------------------------------------------------------------------
    function testFuzz_NonceReplayBlocked(uint256 pk, address sessionKey, uint64 expiryDelta) public {
        pk = bound(pk, 1, type(uint128).max);
        vm.assume(sessionKey != address(0));
        expiryDelta = uint64(bound(uint256(expiryDelta), 1, 365 days));
        uint64 expiry = uint64(block.timestamp + expiryDelta);

        address signer = vm.addr(pk);
        uint256 nonce  = profile.sessionNonce(signer);

        uint8 scope = 0xBF;
        bytes32 d = _digest(sessionKey, expiry, scope, 0, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, d);

        // First register succeeds.
        profile.registerSession(sessionKey, expiry, scope, 0, 0, nonce, v, r, s);
        assertEq(profile.sessionNonce(signer), nonce + 1, "nonce did not bump by 1");

        // Replaying the EXACT same signature must revert with "Invalid nonce"
        // because sessionNonce[signer] is now nonce + 1.
        vm.expectRevert(bytes("Invalid nonce"));
        profile.registerSession(sessionKey, expiry, scope, 0, 0, nonce, v, r, s);
    }

    // ------------------------------------------------------------------
    // Property 3: a tampered scopeBitmap (or any field) recovers a
    //             DIFFERENT signer, whose sessionNonce is 0 (default).
    //             So the recovered-signer's slot mismatches and we get
    //             "Invalid nonce" *or* a different revert. We accept any
    //             revert as a pass — the point is the call doesn't go
    //             through.
    // ------------------------------------------------------------------
    function testFuzz_TamperedScopeRejected(uint256 pk, address sessionKey, uint8 scopeOrig, uint8 scopeTamper, uint64 expiryDelta) public {
        pk = bound(pk, 1, type(uint128).max);
        vm.assume(sessionKey != address(0));
        expiryDelta = uint64(bound(uint256(expiryDelta), 1, 365 days));

        // Avoid 0x40 (WITHDRAW) on either scope to isolate this property.
        scopeOrig   = uint8(bound(uint256(scopeOrig),   0, 0xFF)) & 0xBF;
        scopeTamper = uint8(bound(uint256(scopeTamper), 0, 0xFF)) & 0xBF;
        vm.assume(scopeOrig != scopeTamper);

        uint64 expiry = uint64(block.timestamp + expiryDelta);
        address signer = vm.addr(pk);
        uint256 nonce  = profile.sessionNonce(signer);

        bytes32 d = _digest(sessionKey, expiry, scopeOrig, 0, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, d);

        // Now submit with the TAMPERED scope. The recovered signer is some
        // other address (or address(0)); either way registerSession reverts.
        // We don't pin the revert string — different tampering paths surface
        // different ones (Invalid signature / Invalid nonce). The point is
        // the session is NOT created for `signer`.
        try profile.registerSession(sessionKey, expiry, scopeTamper, 0, 0, nonce, v, r, s) {
            // If this somehow doesn't revert, assert at minimum that the
            // registration didn't land on `signer` (the original intended
            // owner). The sig-recovery would have produced some other addr.
            (uint64 storedExpiry, , , , ) = profile.sessions(signer, sessionKey);
            assertEq(uint256(storedExpiry), 0, "tampered scope landed on signer");
        } catch {
            // Expected.
        }
    }

    // ------------------------------------------------------------------
    // Property 4: WITHDRAW delegation is unconditionally rejected.
    // ------------------------------------------------------------------
    function testFuzz_WithdrawDelegationBlocked(uint256 pk, address sessionKey, uint8 extraBits, uint64 expiryDelta) public {
        pk = bound(pk, 1, type(uint128).max);
        vm.assume(sessionKey != address(0));
        expiryDelta = uint64(bound(uint256(expiryDelta), 1, 365 days));

        // Set bit 6 (WITHDRAW) plus any other arbitrary bits.
        uint8 scope = 0x40 | (extraBits & 0xBF);
        uint64 expiry = uint64(block.timestamp + expiryDelta);

        uint256 nonce = profile.sessionNonce(vm.addr(pk));
        bytes32 d = _digest(sessionKey, expiry, scope, 0, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, d);

        vm.expectRevert(bytes("no WITHDRAW"));
        profile.registerSession(sessionKey, expiry, scope, 0, 0, nonce, v, r, s);
    }

    // ------------------------------------------------------------------
    // Property 5: zero session key always rejected (defense-in-depth — no
    //             ecrecover collapse to address(0) can hijack the slot).
    // ------------------------------------------------------------------
    function testFuzz_ZeroSessionKeyBlocked(uint256 pk, uint8 scope, uint64 expiryDelta) public {
        pk = bound(pk, 1, type(uint128).max);
        scope = uint8(bound(uint256(scope), 0, 0xFF)) & 0xBF;
        expiryDelta = uint64(bound(uint256(expiryDelta), 1, 365 days));
        uint64 expiry = uint64(block.timestamp + expiryDelta);

        uint256 nonce = profile.sessionNonce(vm.addr(pk));
        bytes32 d = _digest(address(0), expiry, scope, 0, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, d);

        vm.expectRevert(bytes("zero key"));
        profile.registerSession(address(0), expiry, scope, 0, 0, nonce, v, r, s);
    }
}
