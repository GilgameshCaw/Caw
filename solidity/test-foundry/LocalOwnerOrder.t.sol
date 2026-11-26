// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AuditRegressionBase} from "./AuditRegressions2026_06_10.t.sol";

contract LocalOwnerOrderTest is AuditRegressionBase {
    function testLocalTransfersPreserveOrderAndInvalidateBothPreviousOwners() public {
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);
        address key = address(0x1234);
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 typeHash = keccak256("TokenSessionDelegation(uint32 profileId,address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)");
        bytes32 message = keccak256(abi.encode(typeHash, TOKEN_ID, key, expiry, uint8(1), uint256(0), uint64(0), uint256(0)));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", cawProfileLedger.eip712DomainHash(), message));
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(0xA1, digest);
        cawProfileLedger.registerTokenScopedSession(TOKEN_ID, key, expiry, 1, 0, 0, 0, v, r, sigS);
        assertEq(cawProfileLedger.validSession(USER, key).expiry, expiry);
        vm.prank(USER);
        cawProfile.transferFrom(USER, USER2, TOKEN_ID);
        assertEq(cawProfileLedger.ownerOf(TOKEN_ID), USER2);
        vm.prank(USER2);
        cawProfile.transferFrom(USER2, USER, TOKEN_ID);
        assertEq(cawProfile.ownerOf(TOKEN_ID), USER);
        assertEq(cawProfileLedger.ownerOf(TOKEN_ID), USER);
        assertEq(cawProfileLedger.validSession(USER, key).expiry, 0);
        assertEq(cawProfileLedger.ownerSessionEpoch(USER), 1);
        assertEq(cawProfileLedger.ownerSessionEpoch(USER2), 1);

        vm.roll(block.number + 1);
        vm.prank(USER);
        cawProfile.transferFrom(USER, USER2, TOKEN_ID);
        assertEq(cawProfileLedger.ownerOf(TOKEN_ID), USER2);
        assertEq(cawProfileLedger.lastOwnerUpdateBlock(TOKEN_ID), block.number);
    }

    function testBatchKeepsRejectingEqualAndOlderStamps() public {
        vm.roll(20);
        _mintAndDeposit(USER, TOKEN_ID, 100 ether);
        uint32[] memory ids = new uint32[](2);
        address[] memory owners = new address[](2);
        uint64[] memory stamps = new uint64[](2);
        ids[0] = ids[1] = TOKEN_ID;
        owners[0] = owners[1] = USER2;
        stamps[0] = 20;
        stamps[1] = 19;
        vm.prank(address(cawProfile));
        cawProfileLedger.updateOwners(ids, owners, stamps);
        assertEq(cawProfileLedger.ownerOf(TOKEN_ID), USER);
        assertEq(cawProfileLedger.lastOwnerUpdateBlock(TOKEN_ID), 20);
    }
}
