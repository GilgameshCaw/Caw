// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @title SmartEOAExecuteTest
/// @notice Tests for SmartEOA.executeBatch — passkey/ecdsaFallback-authorized
///         self-custodial fund moves. Mirrors the P-256 mock strategy of
///         SmartEOA.t.sol (mock verifier installed at 0x0100; valid sigs are
///         pre-registered by their precompile-input hash).
contract SmartEOAExecuteTest is Test {
    // Real NIST P-256 affine coords (same as SmartEOA.t.sol PK1).
    bytes32 constant PK1_X = bytes32(0x4359cf55e848ec6f18a1163aeb2dfe474aad0db80bf5be418b689033e04dd032);
    bytes32 constant PK1_Y = bytes32(0xf18e3dafea96113646f34a71badc522653c4f0bdc86ffc6255db7823b4edd221);
    bytes32 constant SIG_R = bytes32(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa);
    bytes32 constant SIG_S = bytes32(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb);
    bytes constant AUTH_DATA = hex"00000000000000000000000000000000000000000000000000000000000000000000000000";

    uint256 internal constant ECDSA_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant OTHER_PK = 0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0;
    address internal ecdsaAddr;

    SmartEOA internal account;
    P256MockRegistry internal p256Registry;
    Sink internal sink;

    function setUp() public {
        ecdsaAddr = vm.addr(ECDSA_PK);
        p256Registry = new P256MockRegistry();
        MockP256Precompile mock = new MockP256Precompile(address(p256Registry));
        vm.etch(address(0x0100), address(mock).code);

        account = new SmartEOA();
        account.initialize{value: 0}(PK1_X, PK1_Y, ecdsaAddr, payable(address(0)), new bytes(0));

        sink = new Sink();
        // Fund the account so it can forward ETH value.
        vm.deal(address(account), 10 ether);
    }

    // ── digest helpers ────────────────────────────────────────────────────────

    function _executeDigest(SmartEOA acct, SmartEOA.Call[] memory calls, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSep = keccak256(abi.encode(keccak256("SmartEOA"), block.chainid, address(acct)));
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            callHashes[i] = keccak256(abi.encode(calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        bytes32 structHash = keccak256(abi.encode(
            keccak256(bytes("executeBatch")),
            keccak256(abi.encodePacked(callHashes)),
            nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _ecdsaSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // clientDataJSON + P-256 input-hash helpers (copied from SmartEOA.t.sol).
    function _makeCdj(bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            _b64url(abi.encodePacked(digest)),
            '","origin":"https://app.caw.social"}'
        );
    }
    function _computeP256H(bytes memory authData, bytes memory cdj) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(authData, sha256(cdj)));
    }
    function _registerP256(bytes32 digest, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) internal {
        bytes32 h = _computeP256H(AUTH_DATA, _makeCdj(digest));
        p256Registry.register(keccak256(abi.encodePacked(h, r, s, qx, qy)));
    }
    function _webauthnSig(bytes32 digest) internal pure returns (bytes memory) {
        return abi.encode(AUTH_DATA, _makeCdj(digest), SIG_R, SIG_S);
    }

    // base64url (no padding) — minimal, matches the contract's decoder expectation.
    function _b64url(bytes memory data) internal pure returns (bytes memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        if (len == 0) return "";
        uint256 encLen = ((len + 2) / 3) * 4;
        bytes memory out = new bytes(encLen);
        uint256 j = 0;
        for (uint256 i = 0; i < len; i += 3) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;
            out[j++] = table[(triple >> 18) & 0x3F];
            out[j++] = table[(triple >> 12) & 0x3F];
            out[j++] = table[(triple >> 6) & 0x3F];
            out[j++] = table[triple & 0x3F];
        }
        // Trim padding chars for unpadded base64url.
        uint256 mod = len % 3;
        if (mod == 1) { assembly { mstore(out, sub(encLen, 2)) } }
        else if (mod == 2) { assembly { mstore(out, sub(encLen, 1)) } }
        return out;
    }

    function _oneCall(address to, uint256 value, bytes memory data) internal pure returns (SmartEOA.Call[] memory) {
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](1);
        calls[0] = SmartEOA.Call(to, value, data);
        return calls;
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    function test_ecdsa_execute_eth_transfer() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 1 ether, "");
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        account.executeBatch(calls, 0, sig);
        assertEq(address(sink).balance, 1 ether, "sink received ETH");
        assertEq(account.executeNonceOf(), 1, "nonce incremented");
    }

    function test_ecdsa_execute_contract_call() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 0, abi.encodeWithSelector(Sink.poke.selector, 42));
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        account.executeBatch(calls, 0, sig);
        assertEq(sink.last(), 42, "contract call ran");
    }

    function test_ecdsa_batch_two_calls() public {
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](2);
        calls[0] = SmartEOA.Call(address(sink), 0.5 ether, "");
        calls[1] = SmartEOA.Call(address(sink), 0, abi.encodeWithSelector(Sink.poke.selector, 7));
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        account.executeBatch(calls, 0, sig);
        assertEq(address(sink).balance, 0.5 ether, "value forwarded");
        assertEq(sink.last(), 7, "second call ran");
    }

    function test_webauthn_execute() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 0, abi.encodeWithSelector(Sink.poke.selector, 9));
        bytes32 digest = _executeDigest(account, calls, 0);
        _registerP256(digest, SIG_R, SIG_S, PK1_X, PK1_Y);
        account.executeBatch(calls, 0, _webauthnSig(digest));
        assertEq(sink.last(), 9, "webauthn-authorized call ran");
    }

    function test_replay_rejected() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 1 ether, "");
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        account.executeBatch(calls, 0, sig);
        // Same sig + nonce 0 again — nonce is now 1, so the require(nonce==executeNonce) fails.
        vm.expectRevert(SmartEOA.NotPermitted.selector);
        account.executeBatch(calls, 0, sig);
    }

    function test_wrong_signer_rejected() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 1 ether, "");
        bytes memory sig = _ecdsaSig(OTHER_PK, _executeDigest(account, calls, 0)); // not the fallback
        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        account.executeBatch(calls, 0, sig);
    }

    function test_tampered_call_rejected() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 1 ether, "");
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        // Alter the value AFTER signing — digest no longer matches → bad sig.
        calls[0].value = 2 ether;
        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        account.executeBatch(calls, 0, sig);
    }

    function test_empty_batch_rejected() public {
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](0);
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        vm.expectRevert(SmartEOA.EmptyBatch.selector);
        account.executeBatch(calls, 0, sig);
    }

    function test_failing_inner_call_reverts_batch() public {
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 0, abi.encodeWithSelector(Sink.boom.selector));
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(account, calls, 0));
        vm.expectRevert(abi.encodeWithSelector(SmartEOA.ExecuteFailed.selector, uint256(0)));
        account.executeBatch(calls, 0, sig);
        // Nonce must NOT have advanced past a reverted batch... actually it reverts
        // the whole tx including the nonce bump, so nonce stays 0.
        assertEq(account.executeNonceOf(), 0, "reverted batch leaves nonce untouched");
    }

    function test_uninitialized_reverts() public {
        SmartEOA fresh = new SmartEOA();
        SmartEOA.Call[] memory calls = _oneCall(address(sink), 0, "");
        bytes memory sig = _ecdsaSig(ECDSA_PK, _executeDigest(fresh, calls, 0));
        vm.expectRevert(SmartEOA.NotInitialized.selector);
        fresh.executeBatch(calls, 0, sig);
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

contract Sink {
    uint256 public last;
    receive() external payable {}
    function poke(uint256 v) external payable { last = v; }
    function boom() external pure { revert("boom"); }
}

/// @dev Mirrors the P-256 mock from SmartEOA.t.sol.
contract P256MockRegistry {
    mapping(bytes32 => bool) public registered;
    function register(bytes32 inputHash) external { registered[inputHash] = true; }
}

contract MockP256Precompile {
    address public immutable registry;
    constructor(address r) { registry = r; }
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return "";
        if (P256MockRegistry(registry).registered(keccak256(input))) {
            return abi.encode(uint256(1));
        }
        return "";
    }
}
