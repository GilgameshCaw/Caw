// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Origin} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import {CawProfileLedger} from "../contracts/CawProfileLedger.sol";
import {MockLayerZeroEndpoint} from "../contracts/MockLayerZeroEndpoint.sol";

contract RemoteOwnerOrderTest is Test {
    MockLayerZeroEndpoint endpoint;
    CawProfileLedger ledger;
    address constant PROFILE = address(0xCA7);
    address constant FIRST = address(0xA1);
    address constant SECOND = address(0xA2);
    address constant KEY = address(0xA3);
    uint32 tokenId = 1;

    function setUp() public {
        endpoint = new MockLayerZeroEndpoint(2);
        ledger = new CawProfileLedger(1, address(endpoint), address(0), PROFILE,
            address(0x42), address(0x43), false, address(this));
    }

    function deliver(uint64 nonce, uint64 stamp, address owner, bool mintBundle) internal {
        uint32[] memory ids = new uint32[](1);
        address[] memory owners = new address[](1);
        uint64[] memory stamps = new uint64[](1);
        ids[0] = tokenId;
        owners[0] = owner;
        stamps[0] = stamp;
        bytes memory callData;
        if (mintBundle) {
            callData = abi.encodeCall(ledger.lzDepositMintSession, (1, tokenId, 100 ether, "name",
                KEY, uint64(block.timestamp + 1 days), 0, 0, ids, owners, stamps));
        } else {
            callData = abi.encodeCall(ledger.updateOwners, (ids, owners, stamps));
        }
        Origin memory origin = Origin(1, bytes32(uint256(uint160(PROFILE))), nonce);
        vm.prank(address(endpoint));
        ledger.lzReceive(origin, bytes32(uint256(nonce)), bytes.concat(bytes32(0), bytes4(0), callData), address(this), "");
    }

    function testReorderedMintCreditsDepositWithoutGrantingOldKey() public {
        deliver(4, 90, SECOND, false);
        deliver(1, 89, FIRST, true);
        assertEq(ledger.ownerOf(tokenId), SECOND);
        assertEq(ledger.totalCaw(), 100 ether);
        assertEq(ledger.cawBalanceOf(tokenId), 100 ether);
        assertTrue(ledger.authenticated(1, tokenId));
        assertEq(ledger.sessionNonce(SECOND), 0);
        assertEq(ledger.validSession(SECOND, KEY).expiry, 0);
        assertEq(ledger.validSession(FIRST, KEY).expiry, 0);
    }

    function testSameBlockLatePacketsCannotRestoreOwnerOrGrant() public {
        deliver(1, 90, FIRST, true);
        assertGt(ledger.validSession(FIRST, KEY).expiry, 0);
        deliver(4, 90, SECOND, false);
        assertEq(ledger.ownerOf(tokenId), SECOND);
        assertEq(ledger.validSession(FIRST, KEY).expiry, 0);
        deliver(2, 90, FIRST, false);
        deliver(4, 90, SECOND, false);
        assertEq(ledger.ownerOf(tokenId), SECOND);
        deliver(5, 91, FIRST, false);
        assertEq(ledger.ownerOf(tokenId), FIRST);
        assertEq(ledger.validSession(FIRST, KEY).expiry, 0);
        assertEq(ledger.ownerSessionEpoch(FIRST), 1);
        assertEq(ledger.ownerSessionEpoch(SECOND), 1);
    }

    function testSameStampDelayedMintCannotAttachKeyToNewerOwner() public {
        deliver(2, 10, SECOND, false);
        deliver(1, 10, FIRST, true);
        assertEq(ledger.ownerOf(tokenId), SECOND);
        assertEq(ledger.validSession(SECOND, KEY).expiry, 0);
        assertEq(ledger.totalCaw(), 100 ether);
    }

    function testOlderUnrelatedPacketStillCreatesItsIntendedSession() public {
        tokenId = 2;
        deliver(9, 100, SECOND, false);
        tokenId = 1;
        deliver(1, 70, FIRST, true);
        assertEq(ledger.ownerOf(1), FIRST);
        assertEq(ledger.ownerOf(2), SECOND);
        assertGt(ledger.validSession(FIRST, KEY).expiry, 0);
    }

    function testOlderBundleForAnotherNameCannotRestoreWalletAuthority() public {
        deliver(2, 20, FIRST, false);
        deliver(6, 40, SECOND, false);
        tokenId = 2;
        deliver(3, 25, FIRST, true);
        assertEq(ledger.ownerOf(2), FIRST);
        assertEq(ledger.validSession(FIRST, KEY).expiry, 0);
        assertEq(ledger.cawBalanceOf(2), 100 ether);
    }

    function testExplicitlyRevokedKeyRequiresFreshLocalAuthorization() public {
        deliver(1, 10, FIRST, true);
        vm.prank(FIRST);
        ledger.revokeSession(KEY);
        tokenId = 2;
        deliver(2, 11, FIRST, true);
        assertEq(ledger.validSession(FIRST, KEY).expiry, 0);
        assertEq(ledger.ownerOf(2), FIRST);
    }
}
