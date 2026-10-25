// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @dev Real P-256 (vm.signP256) verified by the real EIP-7951 precompile
///      (osaka EVM), no mock at 0x0100.
///
///      test_control_*  : must pass on master and after a fix.
///      test_reject_*   : the behaviour a fix should have. On master these FAIL
///                        if SmartEOA ignores the field under test.
contract SmartEOAWebAuthnFlagsTest is Test {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant FAIL  = 0xffffffff;

    uint256 constant PK      = 0xA11CE;
    uint256 constant PK_EVIL = 0xBAD;

    bytes32 constant DIGEST = keccak256("caw-test-digest");
    string  constant RP     = "app.caw.social";
    string  constant ORIGIN = "https://app.caw.social";

    bytes1 constant UP = 0x01;
    bytes1 constant UV = 0x04;

    SmartEOA acct;
    address fallbackKey = address(0xFA11);

    function setUp() public {
        _requireP256Precompile();
        acct = new SmartEOA();
        (uint256 x, uint256 y) = vm.publicKeyP256(PK);
        acct.initialize(bytes32(x), bytes32(y), fallbackKey, payable(address(0)), "");
    }

    // ---------------------------------------------------------------- helpers

    /// @dev These tests need the real EIP-7951 precompile at 0x0100, which forge
    ///      only has when it runs the osaka EVM (its default as of forge 1.8.5).
    ///      vm.setEvmVersion("osaka") doesn't add it, so check for it here.
    function _requireP256Precompile() internal view {
        bytes32 h = keccak256("p256-precompile-check");
        (bytes32 r, bytes32 s) = vm.signP256(1, h);
        (uint256 x, uint256 y) = vm.publicKeyP256(1);
        (bool ok, bytes memory ret) = address(0x0100).staticcall(abi.encodePacked(h, r, s, x, y));
        require(
            ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1,
            "no P-256 precompile at 0x0100: run with the osaka EVM, not --evm-version prague"
        );
    }

    function _authData(string memory rpId, bytes1 flags) internal pure returns (bytes memory) {
        return abi.encodePacked(sha256(bytes(rpId)), flags, uint32(1));
    }

    function _cdj(string memory typ, bytes32 digest, string memory origin)
        internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            '{"type":"', typ,
            '","challenge":"', _b64url(abi.encodePacked(digest)),
            '","origin":"', origin, '","crossOrigin":false}'
        );
    }

    function _sign(uint256 pk, bytes memory ad, bytes memory cdj) internal pure returns (bytes memory) {
        bytes32 h = sha256(abi.encodePacked(ad, sha256(cdj)));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        return abi.encode(ad, cdj, r, s);
    }

    function _check(bytes memory ad, bytes memory cdj) internal view returns (bytes4) {
        return acct.isValidSignature(DIGEST, _sign(PK, ad, cdj));
    }

    function _b64url(bytes memory data) internal pure returns (bytes memory) {
        bytes memory T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 outLen = (data.length * 8 + 5) / 6;
        bytes memory out = new bytes(outLen);
        uint256 bits; uint256 nbits; uint256 o;
        for (uint256 i = 0; i < data.length; i++) {
            bits = (bits << 8) | uint8(data[i]);
            nbits += 8;
            while (nbits >= 6) { nbits -= 6; out[o++] = T[(bits >> nbits) & 63]; }
        }
        if (nbits > 0) out[o++] = T[(bits << (6 - nbits)) & 63];
        return out;
    }

    function _mgmtDigest(string memory op, bytes memory params, uint256 nonce) internal view returns (bytes32) {
        bytes32 dom = keccak256(abi.encodePacked("SmartEOA", block.chainid, address(acct)));
        bytes32 sh  = keccak256(abi.encodePacked(keccak256(bytes(op)), keccak256(params), nonce));
        return keccak256(abi.encodePacked("\x19\x01", dom, sh));
    }

    // --------------------------------------------------------------- controls

    function test_control_wellFormed_accepted() public view {
        assertEq(_check(_authData(RP, UP | UV), _cdj("webauthn.get", DIGEST, ORIGIN)), MAGIC);
    }

    function test_control_wrongKey_rejected() public view {
        bytes memory sig = _sign(PK_EVIL, _authData(RP, UP | UV), _cdj("webauthn.get", DIGEST, ORIGIN));
        assertEq(acct.isValidSignature(DIGEST, sig), FAIL);
    }

    function test_control_wrongChallenge_rejected() public view {
        bytes memory sig = _sign(PK, _authData(RP, UP | UV), _cdj("webauthn.get", keccak256("other"), ORIGIN));
        assertEq(acct.isValidSignature(DIGEST, sig), FAIL);
    }

    // ------------------------------------------- what a fix should reject

    function test_reject_flagsZero_noUP_noUV() public view {
        assertEq(_check(_authData(RP, 0x00), _cdj("webauthn.get", DIGEST, ORIGIN)), FAIL);
    }

    function test_reject_UPwithoutUV() public view {
        assertEq(_check(_authData(RP, UP), _cdj("webauthn.get", DIGEST, ORIGIN)), FAIL);
    }

    function test_reject_UVwithoutUP() public view {
        assertEq(_check(_authData(RP, UV), _cdj("webauthn.get", DIGEST, ORIGIN)), FAIL);
    }

    function test_reject_typeCreate() public view {
        assertEq(_check(_authData(RP, UP | UV), _cdj("webauthn.create", DIGEST, ORIGIN)), FAIL);
    }

    function test_reject_typeMissing() public view {
        bytes memory cdj = abi.encodePacked('{"challenge":"', _b64url(abi.encodePacked(DIGEST)), '"}');
        assertEq(_check(_authData(RP, UP | UV), cdj), FAIL);
    }

    function test_reject_authDataShort() public view {
        bytes memory ad = abi.encodePacked(sha256(bytes(RP)), UP | UV); // 33 bytes
        assertEq(_check(ad, _cdj("webauthn.get", DIGEST, ORIGIN)), FAIL);
    }

    function test_reject_typeNotFirst() public view {
        bytes memory cdj = abi.encodePacked(
            '{"challenge":"', _b64url(abi.encodePacked(DIGEST)), '","type":"webauthn.get"}'
        );
        assertEq(_check(_authData(RP, UP | UV), cdj), FAIL);
    }

    function test_reject_typeGetSuffix() public view {
        assertEq(_check(_authData(RP, UP | UV), _cdj("webauthn.getX", DIGEST, ORIGIN)), FAIL);
    }

    function test_control_extraFlags_accepted() public view {
        // BE (0x08) + BS (0x10) on a synced passkey must not matter.
        assertEq(_check(_authData(RP, UP | UV | 0x08 | 0x10), _cdj("webauthn.get", DIGEST, ORIGIN)), MAGIC);
    }

    // Known gap, out of scope here: rpIdHash and origin are still not checked
    // (passkeyVerify.ts L92-96, "security finding #1").
    function test_knownGap_otherRpIdHash_stillAccepted() public view {
        assertEq(_check(_authData("evil.example", UP | UV), _cdj("webauthn.get", DIGEST, ORIGIN)), MAGIC);
    }

    function test_knownGap_otherOrigin_stillAccepted() public view {
        assertEq(_check(_authData(RP, UP | UV), _cdj("webauthn.get", DIGEST, "https://evil.example")), MAGIC);
    }

    // Management path (_verifyActivePasskeyGetHash), the strongest op a passkey has.
    function test_reject_rotateFallback_flagsZero_typeCreate() public {
        address newFb = address(0xB0B);
        bytes32 d = _mgmtDigest("rotateEcdsaFallback", abi.encode(newFb), 0);
        bytes memory sig = _sign(PK, _authData(RP, 0x00), _cdj("webauthn.create", d, ORIGIN));
        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        acct.rotateEcdsaFallback(newFb, sig);
    }

    function test_control_rotateFallback_wellFormed() public {
        address newFb = vm.addr(0xB0B);
        bytes32 d = _mgmtDigest("rotateEcdsaFallback", abi.encode(newFb), 0);
        acct.rotateEcdsaFallback(newFb, _sign(PK, _authData(RP, UP | UV), _cdj("webauthn.get", d, ORIGIN)));
        // ecdsaFallback is private: check it through a 65-byte sig from the new key.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, DIGEST);
        assertEq(acct.isValidSignature(DIGEST, abi.encodePacked(r, s, v)), MAGIC);
    }
}
