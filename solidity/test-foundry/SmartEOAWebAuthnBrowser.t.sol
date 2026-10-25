// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @dev Vectors from a real Chromium 147 (CDP virtual authenticator), made by
///      helpers/gen_webauthn_browser_vectors.js. Real EIP-7951 precompile
///      (osaka), no mock.
///      uv_required:    same options as the FE (resident key, UV required).
///                      Its clientDataJSON also carries Chrome's random trailing
///                      "other_keys_can_be_added_here" key, which the prefix check ignores.
///      uv_discouraged: authenticator without UV, e.g. a security key with no PIN.
contract SmartEOAWebAuthnBrowserTest is Test {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant FAIL  = 0xffffffff;
    string json;
    bytes32 digest;

    function setUp() public {
        _requireP256Precompile();
        json = vm.readFile("test-foundry/vectors/browser-webauthn.json");
        digest = vm.parseJsonBytes32(json, ".digest");
    }

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

    function _verify(string memory c) internal returns (bytes4) {
        string memory p = string.concat(".cases.", c, ".");
        SmartEOA acct = new SmartEOA();
        acct.initialize(
            vm.parseJsonBytes32(json, string.concat(p, "pubX")),
            vm.parseJsonBytes32(json, string.concat(p, "pubY")),
            address(0xFA11), payable(address(0)), ""
        );
        bytes memory sig = abi.encode(
            vm.parseJsonBytes(json, string.concat(p, "authenticatorData")),
            vm.parseJsonBytes(json, string.concat(p, "clientDataJSON")),
            vm.parseJsonBytes32(json, string.concat(p, "r")),
            vm.parseJsonBytes32(json, string.concat(p, "s"))
        );
        return acct.isValidSignature(digest, sig);
    }

    // What the FE does (userVerification 'required'): must pass before and after the fix.
    function test_browser_uvRequired_accepted() public {
        assertEq(_verify("uv_required"), MAGIC);
    }

    // Same browser, UV not performed: the fix should reject it.
    function test_browser_uvDiscouraged_rejected() public {
        assertEq(_verify("uv_discouraged"), FAIL);
    }

    // Control: the real assertion bound to another digest is rejected.
    function test_browser_otherDigest_rejected() public {
        string memory p = ".cases.uv_required.";
        SmartEOA acct = new SmartEOA();
        acct.initialize(
            vm.parseJsonBytes32(json, string.concat(p, "pubX")),
            vm.parseJsonBytes32(json, string.concat(p, "pubY")),
            address(0xFA11), payable(address(0)), ""
        );
        bytes memory sig = abi.encode(
            vm.parseJsonBytes(json, string.concat(p, "authenticatorData")),
            vm.parseJsonBytes(json, string.concat(p, "clientDataJSON")),
            vm.parseJsonBytes32(json, string.concat(p, "r")),
            vm.parseJsonBytes32(json, string.concat(p, "s"))
        );
        assertEq(acct.isValidSignature(keccak256("other"), sig), FAIL);
    }
}
