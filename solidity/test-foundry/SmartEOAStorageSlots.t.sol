// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";

/// @notice The FE reads passkeys from storage (services/identity/passkeyState.ts)
///         because the contract has no getters. These tests pin the slots it uses,
///         and the order its recovery re-enroll depends on.
contract SmartEOAStorageSlotsTest is Test {
    bytes32 constant PK1_X = bytes32(uint256(0x11));
    bytes32 constant PK1_Y = bytes32(uint256(0x12));
    bytes32 constant PK2_X = bytes32(uint256(0x21));
    bytes32 constant PK2_Y = bytes32(uint256(0x22));
    uint256 constant RECOVERY_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    SmartEOA account;
    address recovery;

    function setUp() public {
        recovery = vm.addr(RECOVERY_PK);
        account = new SmartEOA();
        account.initialize(PK1_X, PK1_Y, recovery, payable(address(0)), "");
    }

    function _load(uint256 slot) internal view returns (uint256) {
        return uint256(vm.load(address(account), bytes32(slot)));
    }

    function _entryBase(bytes32 pubkeyHash) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(pubkeyHash, uint256(1))));
    }

    function _mgmtSig(string memory op, bytes memory params, uint256 nonce) internal view returns (bytes memory) {
        bytes32 domainSep = keccak256(abi.encodePacked("SmartEOA", block.chainid, address(account)));
        bytes32 structHash = keccak256(abi.encodePacked(keccak256(bytes(op)), keccak256(params), nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECOVERY_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _batchSig(SmartEOA.Call[] memory calls, uint256 nonce) internal view returns (bytes memory) {
        bytes32 domainSep = keccak256(abi.encode(keccak256("SmartEOA"), block.chainid, address(account)));
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(abi.encode(calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        bytes32 structHash = keccak256(abi.encode(
            keccak256("executeBatch"), keccak256(abi.encodePacked(hashes)), nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECOVERY_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_slots_match_the_fe_reader() public {
        bytes32 pk1 = keccak256(abi.encodePacked(PK1_X, PK1_Y));
        bytes32 pk2 = keccak256(abi.encodePacked(PK2_X, PK2_Y));

        // ecdsaFallback shares slot 0 with `initialized`, at offset 1.
        assertEq(address(uint160(_load(0) >> 8)), recovery, "fallback");
        assertEq(_load(0) & 0xff, 1, "initialized");

        // First key, from initialize: active, validFrom == 0.
        assertEq(_load(2), 1, "hash count");
        uint256 hashesBase = uint256(keccak256(abi.encode(uint256(2))));
        assertEq(bytes32(_load(hashesBase)), pk1, "hash[0]");
        assertEq(bytes32(_load(_entryBase(pk1))), PK1_X, "pk1 x");
        assertEq(bytes32(_load(_entryBase(pk1) + 1)), PK1_Y, "pk1 y");
        assertEq(_load(_entryBase(pk1) + 2) >> 64, 0, "pk1 validFrom");

        // Replace it: the new key goes in with a timelock.
        vm.warp(1_000_000);
        account.removePasskey(pk1, _mgmtSig("removePasskey", abi.encode(pk1), 0));
        account.addPasskey(PK2_X, PK2_Y, _mgmtSig("addPasskey", abi.encode(PK2_X, PK2_Y), 1));

        assertEq(_load(2), 1, "hash count after swap");
        assertEq(bytes32(_load(hashesBase)), pk2, "hash[0] after swap");
        uint256 times = _load(_entryBase(pk2) + 2);
        assertEq(times & type(uint64).max, 1_000_000, "enrolledAt");
        assertEq(times >> 64, 1_000_000 + 24 hours, "validFrom");
    }

    /// @dev Why the recovery flow has to find every active key: the FE can't skip the removes.
    function test_recovery_key_cannot_add_while_a_passkey_is_active() public {
        bytes memory sig = _mgmtSig("addPasskey", abi.encode(PK2_X, PK2_Y), 0);
        vm.expectRevert(SmartEOA.InvalidCallerSig.selector);
        account.addPasskey(PK2_X, PK2_Y, sig);
    }

    /// @dev The batch IdentitySection sends, with the nonce offsets it signs.
    function test_recovery_batch_removes_then_adds() public {
        bytes32 pk1 = keccak256(abi.encodePacked(PK1_X, PK1_Y));
        SmartEOA.Call[] memory calls = new SmartEOA.Call[](2);
        calls[0] = SmartEOA.Call(address(account), 0, abi.encodeCall(
            SmartEOA.removePasskey, (pk1, _mgmtSig("removePasskey", abi.encode(pk1), 0))
        ));
        calls[1] = SmartEOA.Call(address(account), 0, abi.encodeCall(
            SmartEOA.addPasskey, (PK2_X, PK2_Y, _mgmtSig("addPasskey", abi.encode(PK2_X, PK2_Y), 1))
        ));

        // Anyone may relay it; the signature authorizes it.
        vm.prank(address(0xbeef));
        account.executeBatch(calls, 0, _batchSig(calls, 0));

        assertEq(account.managementNonceOf(), 2, "management nonce");
        assertEq(_load(2), 1, "one key left");
        assertEq(
            bytes32(_load(uint256(keccak256(abi.encode(uint256(2)))))),
            keccak256(abi.encodePacked(PK2_X, PK2_Y)),
            "the new key"
        );
    }
}
